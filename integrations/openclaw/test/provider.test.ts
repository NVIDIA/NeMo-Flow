// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type {
  OpenClawPluginApi,
  ProviderPlugin,
  ProviderResolveDynamicModelContext,
  ProviderWrapStreamFnContext,
} from 'openclaw/plugin-sdk/plugin-entry';

import { parseConfig } from '../src/config.js';
import { LiveLineageCoordinator } from '../src/lineage.js';
import { NemoRelayProvider, parseUpstreamReference, registerNemoRelayProvider } from '../src/provider.js';
import { createFakeRuntime, logger, model } from './helpers.js';

describe('nemo-relay provider routing', () => {
  it('preserves slashes and rejects recursive routes', () => {
    assert.deepEqual(parseUpstreamReference('openrouter/vendor/model'), {
      provider: 'openrouter',
      modelId: 'vendor/model',
    });
    assert.throws(() => parseUpstreamReference('nemo-relay/nemo-relay/openai/gpt'), /recursive/);
  });

  it('runs the verified upstream stream inline after Relay rewrites the request', async () => {
    const nf = createFakeRuntime();
    const config = parseConfig(undefined);
    const lineage = new LiveLineageCoordinator(nf, config, logger);
    const models = [
      model('openai', 'gpt-5.4', 'openai-responses'),
      model('anthropic', 'claude/sonnet', 'anthropic-messages'),
    ];
    const api = createProviderApi();
    const provider = new NemoRelayProvider(api, config, nf, lineage);
    const registry = {
      getAll: () => models,
      getAvailable: () => models,
      find: (providerId: string, modelId: string) =>
        models.find((candidate) => candidate.provider === providerId && candidate.id === modelId),
      hasConfiguredAuth: () => true,
    };
    const alias = provider.resolveDynamicModel({
      provider: 'nemo-relay',
      modelId: 'openai/gpt-5.4',
      modelRegistry: registry,
    } as ProviderResolveDynamicModelContext);
    assert.equal(alias.provider, 'nemo-relay');
    assert.equal(alias.id, 'openai/gpt-5.4');

    nf.rewriteAnnotated = (annotated) => ({
      ...annotated,
      model: 'nemo-relay/anthropic/claude/sonnet',
      instructions: 'rewritten system prompt',
      params: { temperature: 0.2 },
    });
    const upstreamCalls: Array<{ model: unknown; context: unknown; options: unknown }> = [];
    const assistant = {
      role: 'assistant' as const,
      content: [{ type: 'text' as const, text: 'hello' }],
      api: 'anthropic-messages',
      provider: 'anthropic',
      model: 'claude/sonnet',
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
    const original = async (upstreamModel: unknown, context: unknown, options: unknown) => {
      upstreamCalls.push({ model: upstreamModel, context, options });
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'done' as const, reason: 'stop' as const, message: assistant };
        },
        async result() {
          return assistant;
        },
      };
    };

    lineage.sessionStart({ sessionId: 'session-1' });
    await lineage.beforeAgentRun({
      runId: 'run-1',
      sessionId: 'session-1',
      modelProviderId: 'nemo-relay',
    });
    const wrapped = provider.wrapStreamFn({
      provider: 'nemo-relay',
      modelId: 'openai/gpt-5.4',
      model: alias,
      streamFn: original,
    } as ProviderWrapStreamFnContext);
    const stream = await wrapped(
      alias,
      { systemPrompt: 'original', messages: [] },
      {
        sessionId: 'session-1',
        requestId: 'run-1',
      },
    );
    const events = [];
    for await (const event of stream) events.push(event);
    assert.equal(await stream.result(), assistant);
    assert.equal(events.length, 1);
    assert.equal((upstreamCalls[0]?.model as { provider?: string }).provider, 'anthropic');
    assert.equal((upstreamCalls[0]?.context as { systemPrompt?: string }).systemPrompt, 'rewritten system prompt');
    assert.equal((upstreamCalls[0]?.options as { temperature?: number }).temperature, 0.2);
    assert.equal((upstreamCalls[0]?.options as { apiKey?: string }).apiKey, 'runtime-secret');

    const managedStart = nf.calls.llmStreamCallExecute[0];
    const providerScope = nf.calls.pushScope.find((call) => call.handle.name === 'openclaw.provider.anthropic');
    assert.equal((managedStart?.parent as { uuid?: string }).uuid, lineage.resolveManagedRun('session-1').handle.uuid);
    assert.equal(providerScope?.handle.parentUuid, (managedStart?.handle as { uuid?: string }).uuid);
    assert.equal(lineage.status().counters.managedLlmCompleted, 1);
    await lineage.drain('test');
  });

  it('fails closed for unknown or unsupported provider transports', () => {
    const nf = createFakeRuntime();
    const config = parseConfig(undefined);
    const lineage = new LiveLineageCoordinator(nf, config, logger);
    const provider = new NemoRelayProvider(createProviderApi(), config, nf, lineage);
    const unsupported = model('custom', 'thing', 'custom-create-stream');
    const registry = {
      getAll: () => [unsupported],
      getAvailable: () => [unsupported],
      find: () => unsupported,
      hasConfiguredAuth: () => true,
    };
    assert.throws(
      () =>
        provider.resolveDynamicModel({
          provider: 'nemo-relay',
          modelId: 'custom/thing',
          modelRegistry: registry,
        } as ProviderResolveDynamicModelContext),
      /unsupported or unknown/,
    );
    void lineage.drain('test');
  });

  it('dispatches public compatibility hooks for every verified provider family', () => {
    let registered: ProviderPlugin | undefined;
    const api = {
      registerProvider: (provider: ProviderPlugin) => {
        registered = provider;
      },
      registerModelCatalogProvider: () => undefined,
    } as unknown as OpenClawPluginApi;
    registerNemoRelayProvider(api, parseConfig(undefined), () => undefined);
    assert.ok(registered?.buildReplayPolicy);
    const cases = [
      ['openai/gpt-5.4', 'openai-responses'],
      ['openai-codex/gpt-5.4', 'openai-chatgpt-responses'],
      ['anthropic/claude-sonnet-4-5', 'anthropic-messages'],
      ['google/gemini-2.5-pro', 'google-generative-ai'],
      ['google-vertex/gemini-2.5-pro', 'google-vertex'],
      ['openrouter/vendor/model', 'openai-completions'],
    ] as const;
    for (const [modelId, modelApi] of cases) {
      const policy = registered.buildReplayPolicy({ provider: 'nemo-relay', modelId, modelApi });
      assert.ok(policy, `${modelId} should have a replay compatibility policy`);
      assert.equal(registered.resolveReasoningOutputMode?.({ provider: 'nemo-relay', modelId, modelApi }), 'native');
    }
    assert.deepEqual(
      registered.prepareExtraParams?.({
        provider: 'nemo-relay',
        modelId: 'openai/gpt-5.4',
        model: model('nemo-relay', 'openai/gpt-5.4', 'openai-responses'),
        extraParams: {},
      }),
      { transport: 'sse' },
    );
  });

  it('propagates an upstream producer failure and closes live lineage once', async () => {
    const nf = createFakeRuntime();
    const config = parseConfig(undefined);
    const lineage = new LiveLineageCoordinator(nf, config, logger);
    const upstream = model('anthropic', 'claude-sonnet-4-5', 'anthropic-messages');
    const provider = new NemoRelayProvider(createProviderApi(), config, nf, lineage);
    const registry = {
      getAll: () => [upstream],
      getAvailable: () => [upstream],
      find: () => upstream,
      hasConfiguredAuth: () => true,
    };
    const alias = provider.resolveDynamicModel({
      provider: 'nemo-relay',
      modelId: 'anthropic/claude-sonnet-4-5',
      modelRegistry: registry,
    } as ProviderResolveDynamicModelContext);
    lineage.sessionStart({ sessionId: 'error-session' });
    await lineage.beforeAgentRun({
      runId: 'error-run',
      sessionId: 'error-session',
      modelProviderId: 'nemo-relay',
    });
    const wrapped = provider.wrapStreamFn({
      provider: 'nemo-relay',
      modelId: alias.id,
      model: alias,
      streamFn: async () => ({
        async *[Symbol.asyncIterator]() {
          throw new Error('upstream exploded');
        },
        async result() {
          throw new Error('result should not run');
        },
      }),
    } as ProviderWrapStreamFnContext);
    const stream = await wrapped(alias, { messages: [] }, { sessionId: 'error-session', requestId: 'error-run' });
    await assert.rejects(async () => {
      for await (const _event of stream) {
        // No events are expected.
      }
    }, /upstream exploded/);
    assert.equal(lineage.status().counters.managedLlmFailed, 1);
    const providerEnd = nf.calls.popScope.find((call) => call.handle.name === 'openclaw.provider.anthropic');
    assert.equal((providerEnd?.metadata as { outcome?: string }).outcome, 'error');
    await lineage.drain('test');
    assert.equal(lineage.status().counters.managedLlmFailed, 1);
  });
});

function createProviderApi(): OpenClawPluginApi {
  return {
    runtime: {
      modelAuth: {
        getRuntimeAuthForModel: async () => ({
          apiKey: 'runtime-secret',
          source: 'profile',
          mode: 'api_key',
          baseUrl: 'https://runtime.example.test',
        }),
      },
    },
  } as unknown as OpenClawPluginApi;
}
