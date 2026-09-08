// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { it } from 'node:test';

import type {
  OpenClawPluginApi,
  ProviderResolveDynamicModelContext,
  ProviderWrapStreamFnContext,
} from 'openclaw/plugin-sdk/plugin-entry';

import { parseConfig } from '../src/config.js';
import { LiveLineageCoordinator } from '../src/lineage.js';
import { defaultNemoRelayModuleLoader } from '../src/modules.js';
import { NemoRelayProvider } from '../src/provider.js';
import { logger, model } from './helpers.js';

const enabled = process.env.NEMO_RELAY_OPENCLAW_LIVE_SMOKE === '1';

it('runs live session, agent, tool policy, and cleanup through nemo-relay-node', { skip: !enabled }, async () => {
  const modules = await defaultNemoRelayModuleLoader();
  const activation = await modules.pluginHost.initialize({ version: 1, components: [] });
  const lineage = new LiveLineageCoordinator(modules.nf, parseConfig(undefined), logger);
  try {
    lineage.sessionStart({ sessionId: 'live-session', sessionKey: 'agent:main:live-session' });
    assert.deepEqual(
      await lineage.beforeAgentRun({
        runId: 'live-run',
        sessionId: 'live-session',
        sessionKey: 'agent:main:live-session',
        modelProviderId: 'nemo-relay',
      }),
      { outcome: 'pass' },
    );
    assert.deepEqual(
      await lineage.beforeToolCall(
        { toolName: 'read', params: { path: 'README.md' }, runId: 'live-run', toolCallId: 'live-tool' },
        { runId: 'live-run', toolCallId: 'live-tool' },
      ),
      { params: { path: 'README.md' } },
    );
    lineage.afterToolCall({ runId: 'live-run', toolCallId: 'live-tool', result: { ok: true } });
    await lineage.agentEnd({ runId: 'live-run', success: true }, {});
    await lineage.sessionEnd({ sessionId: 'live-session', reason: 'shutdown' });
    assert.equal(lineage.status().active.sessions, 0);
  } finally {
    await lineage.drain('live_smoke');
    await activation.close();
  }
});

it('runs a managed OpenClaw stream through the native Relay codec', { skip: !enabled }, async () => {
  const modules = await defaultNemoRelayModuleLoader();
  const activation = await modules.pluginHost.initialize({ version: 1, components: [] });
  const config = parseConfig(undefined);
  const lineage = new LiveLineageCoordinator(modules.nf, config, logger);
  const upstreamModel = model('anthropic', 'claude-sonnet-4-5', 'anthropic-messages');
  const registry = {
    getAll: () => [upstreamModel],
    getAvailable: () => [upstreamModel],
    find: (providerId: string, modelId: string) =>
      providerId === upstreamModel.provider && modelId === upstreamModel.id ? upstreamModel : undefined,
    hasConfiguredAuth: () => true,
  };
  const api = {
    runtime: {
      modelAuth: {
        getRuntimeAuthForModel: async () => ({
          apiKey: 'not-used-by-smoke',
          source: 'test',
          mode: 'api_key',
        }),
      },
    },
  } as unknown as OpenClawPluginApi;
  const provider = new NemoRelayProvider(api, config, modules.nf, lineage);
  const alias = provider.resolveDynamicModel({
    provider: 'nemo-relay',
    modelId: 'anthropic/claude-sonnet-4-5',
    modelRegistry: registry,
  } as ProviderResolveDynamicModelContext);
  const assistant = {
    role: 'assistant' as const,
    content: [{ type: 'text' as const, text: 'native bridge ok' }],
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: upstreamModel.id,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop' as const,
    timestamp: Date.now(),
  };
  try {
    lineage.sessionStart({ sessionId: 'managed-session' });
    await lineage.beforeAgentRun({
      runId: 'managed-run',
      sessionId: 'managed-session',
      modelProviderId: 'nemo-relay',
    });
    const wrapped = provider.wrapStreamFn({
      provider: 'nemo-relay',
      modelId: alias.id,
      model: alias,
      streamFn: async () => ({
        async *[Symbol.asyncIterator]() {
          yield { type: 'done' as const, reason: 'stop' as const, message: assistant };
        },
        async result() {
          return assistant;
        },
      }),
    } as ProviderWrapStreamFnContext);
    const stream = await wrapped(
      alias,
      { systemPrompt: 'system', messages: [] },
      {
        sessionId: 'managed-session',
        requestId: 'managed-run',
      },
    );
    const events = [];
    for await (const event of stream) events.push(event);
    assert.equal(events.length, 1);
    const result = await stream.result();
    assert.equal(result.content[0]?.type, 'text');
    assert.equal(result.content[0]?.type === 'text' ? result.content[0].text : undefined, 'native bridge ok');
    assert.equal(lineage.status().counters.managedLlmCompleted, 1);
  } finally {
    await lineage.drain('live_smoke');
    await activation.close();
  }
});
