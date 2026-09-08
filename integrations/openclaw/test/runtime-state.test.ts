// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';

import { registerNemoRelayPlugin } from '../src/runtime-state.js';
import { createModules, logger } from './helpers.js';

describe('OpenClaw plugin registration', () => {
  it('registers provider, catalog, public hooks, service, and status without private tool middleware', async () => {
    const api = createApi({ routing: { favorites: ['openai/gpt-5.4'] } });
    const modules = createModules();
    registerNemoRelayPlugin(api.value, async () => modules);

    assert.equal(api.calls.providers.length, 1);
    assert.equal(api.calls.providers[0]?.id, 'nemo-relay');
    assert.equal(api.calls.catalogs.length, 1);
    assert.deepEqual(await api.calls.catalogs[0]?.staticCatalog?.({}), [
      {
        kind: 'text',
        provider: 'nemo-relay',
        model: 'openai/gpt-5.4',
        label: 'nemo-relay/openai/gpt-5.4',
        source: 'configured',
        configured: true,
      },
    ]);
    assert.deepEqual(
      api.calls.hooks.map((hook) => hook.name),
      [
        'gateway_start',
        'gateway_stop',
        'session_start',
        'session_end',
        'before_agent_run',
        'agent_end',
        'before_tool_call',
        'after_tool_call',
        'llm_input',
        'llm_output',
        'subagent_spawned',
        'subagent_ended',
      ],
    );

    await api.calls.services[0]?.start({ stateDir: '/tmp', logger });
    await invoke(api, 'session_start', { sessionId: 'session-1' }, { sessionId: 'session-1' });
    assert.deepEqual(
      await invoke(
        api,
        'before_agent_run',
        { prompt: 'hello', messages: [] },
        { runId: 'run-1', sessionId: 'session-1', modelProviderId: 'nemo-relay' },
      ),
      { outcome: 'pass' },
    );
    assert.deepEqual(
      await invoke(
        api,
        'before_tool_call',
        { toolName: 'read', params: { path: 'README.md' }, runId: 'run-1', toolCallId: 'tool-1' },
        { toolName: 'read', runId: 'run-1', toolCallId: 'tool-1' },
      ),
      { params: { path: 'README.md' } },
    );
    await invoke(
      api,
      'after_tool_call',
      { toolName: 'read', params: {}, runId: 'run-1', toolCallId: 'tool-1', result: { ok: true } },
      {},
    );
    await invoke(api, 'agent_end', { runId: 'run-1', messages: [], success: true }, { runId: 'run-1' });
    await invoke(api, 'session_end', { sessionId: 'session-1', messageCount: 1 }, { sessionId: 'session-1' });

    let health: unknown;
    api.calls.gatewayMethods[0]?.handler({
      respond: (_ok: boolean, value: unknown) => {
        health = value;
      },
    });
    assert.equal((health as { inProcess?: boolean }).inProcess, true);
    assert.equal((health as { gateway?: boolean }).gateway, false);
    assert.equal((health as { toolExecutionIntercepts?: boolean }).toolExecutionIntercepts, false);
    await api.calls.services[0]?.stop?.({ stateDir: '/tmp', logger });
  });

  it('does not register when disabled or during discovery', () => {
    const disabled = createApi({ enabled: false });
    registerNemoRelayPlugin(disabled.value, async () => createModules());
    assert.equal(disabled.calls.providers.length, 0);

    const discovery = createApi(undefined, 'discovery');
    registerNemoRelayPlugin(discovery.value, async () => createModules());
    assert.equal(discovery.calls.providers.length, 0);
  });
});

type Hook = { name: string; handler: (event: any, ctx: any) => any };

function createApi(pluginConfig?: Record<string, unknown>, registrationMode: 'full' | 'discovery' = 'full') {
  const calls = {
    providers: [] as any[],
    catalogs: [] as any[],
    services: [] as any[],
    lifecycle: [] as any[],
    gatewayMethods: [] as any[],
    hooks: [] as Hook[],
  };
  const value = {
    id: 'nemo-relay',
    version: '2026.9.3',
    registrationMode,
    pluginConfig,
    logger,
    resolvePath: (value: string) => value,
    runtime: {
      state: { resolveStateDir: () => '/tmp' },
      modelAuth: { getRuntimeAuthForModel: async () => ({ source: 'none', mode: 'none' }) },
    },
    registerProvider: (provider: unknown) => calls.providers.push(provider),
    registerModelCatalogProvider: (catalog: unknown) => calls.catalogs.push(catalog),
    registerService: (service: unknown) => calls.services.push(service),
    registerRuntimeLifecycle: (lifecycle: unknown) => calls.lifecycle.push(lifecycle),
    registerGatewayMethod: (method: string, handler: unknown) => calls.gatewayMethods.push({ method, handler }),
    on: (name: string, handler: Hook['handler']) => calls.hooks.push({ name, handler }),
  };
  return { value: value as unknown as OpenClawPluginApi, calls };
}

function invoke(api: ReturnType<typeof createApi>, name: string, event: unknown, ctx: unknown): unknown {
  const hook = api.calls.hooks.find((candidate) => candidate.name === name);
  assert.ok(hook, `missing ${name} hook`);
  return hook.handler(event, ctx);
}
