// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseConfig } from '../src/config.js';
import { LiveLineageCoordinator } from '../src/lineage.js';
import { createFakeRuntime, logger } from './helpers.js';

describe('live OpenClaw lineage', () => {
  it('creates session, run, LLM-causal tool, and closes leaf to root', async () => {
    const nf = createFakeRuntime();
    nf.rewriteTool = (args) => ({ ...args, rewritten: true });
    const lineage = new LiveLineageCoordinator(nf, parseConfig(undefined), logger);

    lineage.sessionStart({ sessionId: 'session-1', sessionKey: 'agent:main:session-1' });
    assert.deepEqual(
      await lineage.beforeAgentRun({
        runId: 'run-1',
        sessionId: 'session-1',
        sessionKey: 'agent:main:session-1',
        modelProviderId: 'nemo-relay',
      }),
      { outcome: 'pass' },
    );
    const run = lineage.resolveManagedRun('session-1', 'run-1');
    const call = lineage.startManagedCall(run, 'request-1');
    lineage.finishManagedCall(call, {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'tool-1', name: 'shell', arguments: {} }],
    });

    assert.deepEqual(
      await lineage.beforeToolCall(
        { toolName: 'shell', params: { command: 'pwd' }, runId: 'run-1', toolCallId: 'tool-1' },
        { runId: 'run-1', toolCallId: 'tool-1' },
      ),
      { params: { command: 'pwd', rewritten: true } },
    );
    const toolStart = nf.calls.toolCall[0];
    assert.equal((toolStart?.parent as { uuid?: string }).uuid, run.handle.uuid);
    assert.equal(
      ((toolStart?.rest as unknown[])[2] as { originating_llm_call_id?: string }).originating_llm_call_id,
      call.id,
    );
    lineage.afterToolCall({ runId: 'run-1', toolCallId: 'tool-1', result: { ok: true }, durationMs: 3 });
    await lineage.agentEnd({ runId: 'run-1', success: true }, {});
    await lineage.sessionEnd({ sessionId: 'session-1', reason: 'idle' });

    assert.equal(lineage.status().active.sessions, 0);
    assert.equal(lineage.status().counters.toolsCompleted, 1);
    assert.equal(lineage.status().counters.managedLlmCompleted, 1);
    await lineage.drain('test');
  });

  it('rejects a second managed run and ambiguous managed stream inference', async () => {
    const lineage = new LiveLineageCoordinator(createFakeRuntime(), parseConfig(undefined), logger);
    lineage.sessionStart({ sessionId: 'session-1' });
    assert.deepEqual(
      await lineage.beforeAgentRun({ runId: 'run-1', sessionId: 'session-1', modelProviderId: 'nemo-relay' }),
      { outcome: 'pass' },
    );
    const decision = await lineage.beforeAgentRun({
      runId: 'run-2',
      sessionId: 'session-1',
      modelProviderId: 'nemo-relay',
    });
    assert.equal(decision.outcome, 'block');
    assert.equal(lineage.status().counters.ambiguousRun, 1);
    assert.throws(() => lineage.resolveManagedRun('missing'), /no active agent run/);
    await lineage.drain('test');
  });

  it('defers child sessions and parents run-mode and long-lived children correctly', async () => {
    const nf = createFakeRuntime();
    const lineage = new LiveLineageCoordinator(nf, parseConfig(undefined), logger);
    lineage.sessionStart({ sessionId: 'parent', sessionKey: 'agent:main:parent' });
    await lineage.beforeAgentRun({
      runId: 'parent-run',
      sessionId: 'parent',
      sessionKey: 'agent:main:parent',
      modelProviderId: 'nemo-relay',
    });
    const parent = lineage.resolveManagedRun('parent', 'parent-run');

    lineage.sessionStart({ sessionId: 'child-run-session', sessionKey: 'agent:main:subagent:run-child' });
    assert.equal(lineage.status().active.deferredSessions, 1);
    lineage.subagentSpawned(
      { childSessionKey: 'agent:main:subagent:run-child', mode: 'run', runId: 'child-run' },
      { requesterSessionKey: 'agent:main:parent', runId: 'child-run' },
    );
    assert.equal(lineage.status().active.deferredSessions, 0);
    const runModeScope = nf.calls.pushScope.find(
      (call) => (call.metadata as { session_id?: string })?.session_id === 'child-run-session',
    );
    assert.equal(runModeScope?.handle.parentUuid, parent.handle.uuid);

    lineage.subagentSpawned(
      { childSessionKey: 'agent:main:subagent:long-child', mode: 'session', runId: 'long-child-run' },
      { requesterSessionKey: 'agent:main:parent', runId: 'long-child-run' },
    );
    lineage.sessionStart({ sessionId: 'long-child-session', sessionKey: 'agent:main:subagent:long-child' });
    const longScope = nf.calls.pushScope.find(
      (call) => (call.metadata as { session_id?: string })?.session_id === 'long-child-session',
    );
    assert.equal(longScope?.handle.parentUuid, parent.session.handle.uuid);
    assert.equal((longScope?.metadata as { requester_run_id?: string }).requester_run_id, 'parent-run');
    await lineage.drain('test');
  });
});
