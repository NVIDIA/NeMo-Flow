// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'node:crypto';

import type { PluginLogger } from 'openclaw/plugin-sdk/plugin-entry';

import type { NemoRelayOpenClawConfig } from './config.js';
import type { NemoRelayRuntimeModule } from './modules.js';

const INCOMPLETE_TTL_MS = 5 * 60 * 1_000;
const MAX_INCOMPLETE = 1_024;
const SUBAGENT_GATE_MS = 1_000;

type ScopeHandle = ReturnType<NemoRelayRuntimeModule['pushScope']>;
type ScopeStack = ReturnType<NemoRelayRuntimeModule['createScopeStack']>;
type ToolHandle = ReturnType<NemoRelayRuntimeModule['toolCall']>;
type LlmHandle = ReturnType<NemoRelayRuntimeModule['llmCall']>;
type ManagedStream = Awaited<ReturnType<NemoRelayRuntimeModule['llmStreamCallExecute']>>;

type LiveScope = {
  handle: ScopeHandle;
  stack: ScopeStack;
  rootUuid: string;
  startedAt: number;
  ended: boolean;
};

type SessionRecord = LiveScope & {
  sessionId?: string;
  sessionKey?: string;
  isSubagent: boolean;
  mode?: 'run' | 'session';
  activeRuns: Set<string>;
};

export type RunRecord = LiveScope & {
  runId: string;
  session: SessionRecord;
};

type ToolRecord = {
  key: string;
  run: RunRecord;
  handle: ToolHandle;
  toolName: string;
  toolCallId: string;
  startedAt: number;
  spawnCandidate: boolean;
};

type FallbackRecord = {
  run: RunRecord;
  handle: LlmHandle;
  provider: string;
  model: string;
  startedAt: number;
};

type ManagedCallRecord = {
  id: string;
  run: RunRecord;
  requestId?: string;
  startedAt: number;
  stream?: ManagedStream;
  cancel?: () => void;
  abandoning: boolean;
};

type DeferredSession = {
  sessionId: string;
  sessionKey: string;
  startedAt: number;
};

type SubagentEdge = {
  childSessionKey: string;
  childRunId: string;
  requesterSessionKey: string;
  requesterRun: RunRecord;
  mode: 'run' | 'session';
  spawningToolCallId?: string;
  spawnAmbiguous: boolean;
  startedAt: number;
};

export type LineageCounters = {
  missingRun: number;
  ambiguousRun: number;
  orphanSubagent: number;
  ambiguousSpawnTool: number;
  managedLlmStarted: number;
  managedLlmCompleted: number;
  managedLlmFailed: number;
  fallbackLlmStarted: number;
  fallbackLlmCompleted: number;
  fallbackLlmSkipped: number;
  toolsStarted: number;
  toolsCompleted: number;
  abandoned: number;
};

export type LineageStatus = {
  counters: LineageCounters;
  active: {
    sessions: number;
    runs: number;
    tools: number;
    managedLlmCalls: number;
    fallbackLlmCalls: number;
    deferredSessions: number;
  };
};

/** Owns live Relay handles. It deliberately stores no transcript or replay data. */
export class LiveLineageCoordinator {
  private readonly nf: NemoRelayRuntimeModule;
  private readonly config: NemoRelayOpenClawConfig;
  private readonly logger: PluginLogger;
  private readonly sessionsById = new Map<string, SessionRecord>();
  private readonly sessionsByKey = new Map<string, SessionRecord>();
  private readonly sessionRecords = new Set<SessionRecord>();
  private readonly runs = new Map<string, RunRecord>();
  private readonly tools = new Map<string, ToolRecord>();
  private readonly fallback = new Map<string, FallbackRecord>();
  private readonly managed = new Map<string, ManagedCallRecord>();
  private readonly toolOrigins = new Map<string, { managedCallId: string; startedAt: number }>();
  private readonly deferredSessions = new Map<string, DeferredSession>();
  private readonly subagentEdges = new Map<string, SubagentEdge>();
  private readonly edgeWaiters = new Map<string, Set<() => void>>();
  private cleanupTimer?: NodeJS.Timeout;
  private readonly counters: LineageCounters = {
    missingRun: 0,
    ambiguousRun: 0,
    orphanSubagent: 0,
    ambiguousSpawnTool: 0,
    managedLlmStarted: 0,
    managedLlmCompleted: 0,
    managedLlmFailed: 0,
    fallbackLlmStarted: 0,
    fallbackLlmCompleted: 0,
    fallbackLlmSkipped: 0,
    toolsStarted: 0,
    toolsCompleted: 0,
    abandoned: 0,
  };

  constructor(nf: NemoRelayRuntimeModule, config: NemoRelayOpenClawConfig, logger: PluginLogger) {
    this.nf = nf;
    this.config = config;
    this.logger = logger;
    this.cleanupTimer = setInterval(() => this.evictExpired(), 30_000);
    this.cleanupTimer.unref();
  }

  status(): LineageStatus {
    return {
      counters: { ...this.counters },
      active: {
        sessions: this.sessionRecords.size,
        runs: this.runs.size,
        tools: this.tools.size,
        managedLlmCalls: this.managed.size,
        fallbackLlmCalls: this.fallback.size,
        deferredSessions: this.deferredSessions.size,
      },
    };
  }

  sessionStart(event: { sessionId: string; sessionKey?: string }): void {
    if (this.findSession(event.sessionId, event.sessionKey)) {
      return;
    }
    const edge = event.sessionKey ? this.subagentEdges.get(event.sessionKey) : undefined;
    if (event.sessionKey && isSubagentKey(event.sessionKey) && (!edge || edge.spawnAmbiguous)) {
      this.deferredSessions.set(event.sessionKey, {
        sessionId: event.sessionId,
        sessionKey: event.sessionKey,
        startedAt: Date.now(),
      });
      this.notifyEdge(event.sessionKey);
      this.enforceBounds();
      return;
    }
    this.openSession(event.sessionId, event.sessionKey, edge);
    this.enforceBounds();
  }

  async beforeAgentRun(ctx: {
    runId?: string;
    sessionId?: string;
    sessionKey?: string;
    modelProviderId?: string;
  }): Promise<{ outcome: 'pass' } | { outcome: 'block'; reason: string; message: string }> {
    const managed = ctx.modelProviderId === 'nemo-relay';
    if (!ctx.runId) {
      this.counters.missingRun += 1;
      if (!managed) this.emitLineageDiagnostic('missing_run', ctx.sessionId, { session_key: ctx.sessionKey });
      return managed ? block('missing OpenClaw run id') : { outcome: 'pass' };
    }
    if (this.runs.has(ctx.runId)) {
      return { outcome: 'pass' };
    }

    if (ctx.sessionKey && isSubagentKey(ctx.sessionKey) && !this.edgeReady(ctx.sessionKey)) {
      await this.waitForEdge(ctx.sessionKey);
    }
    let session = this.findSession(ctx.sessionId, ctx.sessionKey);
    if (!session && ctx.sessionKey) {
      const deferred = this.deferredSessions.get(ctx.sessionKey);
      const edge = this.subagentEdges.get(ctx.sessionKey);
      if (deferred && edge && !edge.spawnAmbiguous) {
        session = this.openSession(deferred.sessionId, deferred.sessionKey, edge);
        this.deferredSessions.delete(ctx.sessionKey);
      }
    }
    if (!session) {
      if (ctx.sessionKey && isSubagentKey(ctx.sessionKey)) {
        this.counters.orphanSubagent += 1;
      } else {
        this.counters.missingRun += 1;
      }
      return managed ? block('no deterministic Relay session parent') : { outcome: 'pass' };
    }
    if (session.activeRuns.size !== 0) {
      this.counters.ambiguousRun += 1;
      if (!managed) this.emitLineageDiagnostic('ambiguous_run', session.sessionId, { session_key: session.sessionKey });
      return managed ? block('multiple active agent runs in one session') : { outcome: 'pass' };
    }

    const scope = this.openChildScope(
      session.rootUuid,
      session.handle,
      `openclaw.agent.${ctx.runId}`,
      this.nf.ScopeType.Agent,
      {
        run_id: ctx.runId,
        session_id: session.sessionId,
        session_key: session.sessionKey,
      },
    );
    const run: RunRecord = { ...scope, runId: ctx.runId, session };
    this.runs.set(ctx.runId, run);
    session.activeRuns.add(ctx.runId);
    this.enforceBounds();
    return { outcome: 'pass' };
  }

  async agentEnd(
    event: { runId?: string; success: boolean; error?: string; durationMs?: number },
    ctx: { runId?: string },
  ): Promise<void> {
    const runId = event.runId ?? ctx.runId;
    if (!runId) {
      return;
    }
    const run = this.runs.get(runId);
    if (!run) {
      return;
    }
    this.runs.delete(runId);
    run.session.activeRuns.delete(runId);
    await this.closeRunChildren(runId, 'agent_end');
    this.popLiveScope(
      run,
      {
        success: event.success,
        ...(event.error ? { error: event.error } : {}),
      },
      {
        outcome: event.success ? 'success' : 'error',
        ...(event.durationMs === undefined ? {} : { duration_ms: event.durationMs }),
      },
    );
  }

  async sessionEnd(event: {
    sessionId: string;
    sessionKey?: string;
    reason?: string;
    durationMs?: number;
  }): Promise<void> {
    const session = this.findSession(event.sessionId, event.sessionKey);
    if (!session) {
      if (event.sessionKey) this.deferredSessions.delete(event.sessionKey);
      return;
    }
    for (const runId of [...session.activeRuns]) {
      await this.abandonRun(runId, 'session_end');
    }
    this.closeSession(session, event.reason ?? 'session_end', event.durationMs);
  }

  subagentSpawned(
    event: { childSessionKey: string; mode: 'run' | 'session'; runId: string },
    ctx: { requesterSessionKey?: string; runId?: string },
  ): void {
    const requesterSession = ctx.requesterSessionKey ? this.sessionsByKey.get(ctx.requesterSessionKey) : undefined;
    const contextualRun = ctx.runId ? this.runs.get(ctx.runId) : undefined;
    const requesterRun = contextualRun?.session === requesterSession ? contextualRun : this.uniqueRun(requesterSession);
    if (!requesterRun || !ctx.requesterSessionKey) {
      this.counters.orphanSubagent += 1;
      this.notifyEdge(event.childSessionKey);
      return;
    }
    const candidates = [...this.tools.values()].filter(
      (tool) => tool.run.runId === requesterRun.runId && tool.spawnCandidate,
    );
    const soleCandidate = candidates.length === 1 ? candidates[0] : undefined;
    const edge: SubagentEdge = {
      childSessionKey: event.childSessionKey,
      childRunId: event.runId,
      requesterSessionKey: ctx.requesterSessionKey,
      requesterRun,
      mode: event.mode,
      spawnAmbiguous: candidates.length > 1,
      startedAt: Date.now(),
      ...(soleCandidate === undefined ? {} : { spawningToolCallId: soleCandidate.toolCallId }),
    };
    if (edge.spawnAmbiguous) {
      this.counters.ambiguousSpawnTool += 1;
    }
    this.subagentEdges.set(event.childSessionKey, edge);
    const deferred = this.deferredSessions.get(event.childSessionKey);
    if (deferred && !edge.spawnAmbiguous) {
      this.openSession(deferred.sessionId, deferred.sessionKey, edge);
      this.deferredSessions.delete(event.childSessionKey);
    }
    this.notifyEdge(event.childSessionKey);
  }

  async subagentEnded(event: {
    targetSessionKey: string;
    outcome?: string;
    error?: string;
    reason: string;
  }): Promise<void> {
    const edge = this.subagentEdges.get(event.targetSessionKey);
    const session = this.sessionsByKey.get(event.targetSessionKey);
    if (session && edge?.mode === 'run') {
      for (const runId of [...session.activeRuns]) await this.abandonRun(runId, 'subagent_ended');
      this.closeSession(session, event.error ?? event.outcome ?? event.reason);
    }
    this.subagentEdges.delete(event.targetSessionKey);
    this.deferredSessions.delete(event.targetSessionKey);
    this.notifyEdge(event.targetSessionKey);
  }

  resolveManagedRun(sessionId: string | undefined, requestId?: string): RunRecord {
    if (requestId) {
      const exact = this.runs.get(requestId);
      if (exact && (!sessionId || exact.session.sessionId === sessionId)) return exact;
    }
    const session = this.findSession(sessionId, undefined);
    if (!session || session.activeRuns.size === 0) {
      this.counters.missingRun += 1;
      throw new Error('nemo-relay managed call has no active agent run');
    }
    if (session.activeRuns.size !== 1) {
      this.counters.ambiguousRun += 1;
      throw new Error('nemo-relay managed call has ambiguous agent lineage');
    }
    const run = this.runs.get([...session.activeRuns][0] ?? '');
    if (!run) {
      this.counters.missingRun += 1;
      throw new Error('nemo-relay managed call parent disappeared');
    }
    return run;
  }

  startManagedCall(run: RunRecord, requestId?: string): ManagedCallRecord {
    const record: ManagedCallRecord = {
      id: randomUUID(),
      run,
      startedAt: Date.now(),
      abandoning: false,
      ...(requestId === undefined ? {} : { requestId }),
    };
    this.managed.set(record.id, record);
    this.counters.managedLlmStarted += 1;
    this.enforceBounds();
    return record;
  }

  bindManagedStream(record: ManagedCallRecord, stream: ManagedStream, cancel: () => void): void {
    if (!this.managed.has(record.id)) {
      cancel();
      void stream.close().catch(() => undefined);
      return;
    }
    record.stream = stream;
    record.cancel = cancel;
  }

  finishManagedCall(record: ManagedCallRecord, result: unknown, error?: unknown): void {
    if (!this.managed.delete(record.id)) return;
    if (error === undefined) {
      this.counters.managedLlmCompleted += 1;
      this.recordToolOrigins(record.run.runId, record.id, result);
    } else {
      this.counters.managedLlmFailed += 1;
    }
  }

  fallbackInput(event: {
    runId: string;
    sessionId: string;
    provider: string;
    model: string;
    systemPrompt?: string;
    prompt: string;
    historyMessages: unknown[];
    tools?: unknown[];
  }): void {
    if (!this.config.fallback.enabled || event.provider === 'nemo-relay') return;
    const run = this.runs.get(event.runId);
    if (!run || this.fallback.has(event.runId)) {
      if (!run) {
        this.counters.missingRun += 1;
        this.emitLineageDiagnostic('missing_run', event.sessionId, { fallback: true });
      } else {
        this.counters.ambiguousRun += 1;
        this.emitLineageDiagnostic('ambiguous_run', event.sessionId, { fallback: true, run_id: event.runId });
      }
      this.counters.fallbackLlmSkipped += 1;
      return;
    }
    const content = {
      model: `${event.provider}/${event.model}`,
      systemPrompt: event.systemPrompt,
      prompt: event.prompt,
      messages: jsonCompatible(event.historyMessages),
      tools: jsonCompatible(event.tools),
    };
    const handle = this.inStack(run.stack, () =>
      this.nf.llmCall(
        event.provider,
        { headers: { run_id: event.runId, session_id: event.sessionId }, content },
        run.handle,
        undefined,
        undefined,
        { fallback: true },
        event.model,
      ),
    );
    this.fallback.set(event.runId, {
      run,
      handle,
      provider: event.provider,
      model: event.model,
      startedAt: Date.now(),
    });
    this.counters.fallbackLlmStarted += 1;
    this.enforceBounds();
  }

  fallbackOutput(event: {
    runId: string;
    provider: string;
    model: string;
    assistantTexts: string[];
    lastAssistant?: unknown;
    usage?: unknown;
  }): void {
    if (!this.config.fallback.enabled || event.provider === 'nemo-relay') return;
    const record = this.fallback.get(event.runId);
    if (!record || record.provider !== event.provider || record.model !== event.model) {
      this.counters.fallbackLlmSkipped += 1;
      const run = this.runs.get(event.runId);
      if (run)
        this.emitRunDiagnostic(run, 'unmatched_fallback_output', { provider: event.provider, model: event.model });
      else this.logger.warn?.('nemo-relay skipped unmatched fallback LLM output without a live run');
      return;
    }
    const response = jsonCompatible({
      assistantTexts: event.assistantTexts,
      lastAssistant: event.lastAssistant,
      usage: event.usage,
    });
    this.inStack(record.run.stack, () =>
      this.nf.llmCallEnd(record.handle, response ?? {}, undefined, { fallback: true, outcome: 'success' }),
    );
    this.fallback.delete(event.runId);
    this.counters.fallbackLlmCompleted += 1;
  }

  async beforeToolCall(
    event: { toolName: string; params: Record<string, unknown>; runId?: string; toolCallId?: string },
    ctx: { runId?: string; toolCallId?: string },
  ): Promise<{ params?: Record<string, unknown>; block?: boolean; blockReason?: string }> {
    const runId = event.runId ?? ctx.runId;
    const toolCallId = event.toolCallId ?? ctx.toolCallId;
    const run = runId ? this.runs.get(runId) : undefined;
    if (!run || !runId || !toolCallId) {
      this.counters.missingRun += 1;
      return { block: true, blockReason: 'NeMo Relay could not establish deterministic tool lineage' };
    }
    try {
      const rewritten = await this.inStack(run.stack, async () => {
        await this.nf.toolConditionalExecution(event.toolName, event.params);
        return await this.nf.toolRequestIntercepts(event.toolName, event.params);
      });
      const params = asJsonRecord(rewritten, 'Relay tool request intercept');
      const key = toolKey(runId, toolCallId);
      if (this.tools.has(key)) {
        return { block: true, blockReason: 'Duplicate active OpenClaw tool call id' };
      }
      const originatingLlm = this.toolOrigins.get(key)?.managedCallId;
      const handle = this.inStack(run.stack, () =>
        this.nf.toolCall(
          event.toolName,
          params,
          run.handle,
          undefined,
          undefined,
          {
            run_id: runId,
            ...(originatingLlm ? { originating_llm_call_id: originatingLlm } : {}),
          },
          toolCallId,
        ),
      );
      this.tools.set(key, {
        key,
        run,
        handle,
        toolName: event.toolName,
        toolCallId,
        startedAt: Date.now(),
        spawnCandidate: event.toolName === 'sessions_spawn',
      });
      this.counters.toolsStarted += 1;
      this.enforceBounds();
      return { params };
    } catch (error) {
      return { block: true, blockReason: toMessage(error) };
    }
  }

  afterToolCall(event: {
    runId?: string;
    toolCallId?: string;
    result?: unknown;
    error?: string;
    durationMs?: number;
  }): void {
    if (!event.runId || !event.toolCallId) return;
    const key = toolKey(event.runId, event.toolCallId);
    const record = this.tools.get(key);
    if (!record) return;
    if (record.spawnCandidate) this.resolveSpawnTool(record, event.result);
    this.inStack(record.run.stack, () =>
      this.nf.toolCallEnd(
        record.handle,
        {
          result: jsonCompatible(event.result) ?? null,
          annotation: {
            outcome: event.error ? 'error' : 'success',
            ...(event.error ? { error: event.error } : {}),
          },
        },
        undefined,
        { ...(event.durationMs === undefined ? {} : { duration_ms: event.durationMs }) },
      ),
    );
    this.tools.delete(key);
    this.toolOrigins.delete(key);
    this.counters.toolsCompleted += 1;
  }

  async drain(reason: string): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      delete this.cleanupTimer;
    }
    for (const key of [...this.tools.keys()]) this.abandonTool(key, reason);
    for (const runId of [...this.fallback.keys()]) this.abandonFallback(runId, reason);
    for (const record of [...this.managed.values()]) await this.abandonManaged(record, reason);
    for (const runId of [...this.runs.keys()]) await this.abandonRun(runId, reason);
    for (const session of [...this.sessionRecords]) this.closeSession(session, reason);
    this.deferredSessions.clear();
    this.subagentEdges.clear();
    await this.nf.flushSubscribers?.();
  }

  private openSession(sessionId: string, sessionKey?: string, edge?: SubagentEdge): SessionRecord {
    const existing = this.findSession(sessionId, sessionKey);
    if (existing) return existing;
    let scope: LiveScope;
    let isSubagent = false;
    if (edge) {
      isSubagent = true;
      const structuralParent = edge.mode === 'run' ? edge.requesterRun.handle : edge.requesterRun.session.handle;
      scope = this.openChildScope(
        edge.requesterRun.rootUuid,
        structuralParent,
        `openclaw.subagent.${edge.childSessionKey}`,
        this.nf.ScopeType.Agent,
        {
          session_id: sessionId,
          session_key: sessionKey,
          subagent_mode: edge.mode,
          requester_run_id: edge.requesterRun.runId,
          requester_scope_uuid: edge.requesterRun.handle.uuid,
          ...(edge.spawningToolCallId ? { spawning_tool_call_id: edge.spawningToolCallId } : {}),
        },
      );
    } else {
      const stack = this.nf.createScopeStack();
      const handle = this.inStack(stack, () =>
        this.nf.pushScope(`openclaw.session.${sessionId}`, this.nf.ScopeType.Agent, undefined, undefined, undefined, {
          session_id: sessionId,
          session_key: sessionKey,
        }),
      );
      scope = { handle, stack, rootUuid: handle.uuid, startedAt: Date.now(), ended: false };
    }
    const record: SessionRecord = {
      ...scope,
      sessionId,
      ...(sessionKey === undefined ? {} : { sessionKey }),
      isSubagent,
      ...(edge === undefined ? {} : { mode: edge.mode }),
      activeRuns: new Set(),
    };
    this.sessionsById.set(sessionId, record);
    if (sessionKey) this.sessionsByKey.set(sessionKey, record);
    this.sessionRecords.add(record);
    return record;
  }

  private openChildScope(
    rootUuid: string,
    parent: ScopeHandle,
    name: string,
    scopeType: Parameters<NemoRelayRuntimeModule['pushScope']>[1],
    metadata: Record<string, unknown>,
  ): LiveScope {
    const stack = this.nf.createScopeStackFromPropagation({ version: 1, rootUuid, parentUuid: parent.uuid });
    const handle = this.inStack(stack, () =>
      this.nf.pushScope(name, scopeType, parent, undefined, undefined, jsonCompatible(metadata)),
    );
    return { handle, stack, rootUuid, startedAt: Date.now(), ended: false };
  }

  private popLiveScope(scope: LiveScope, output: unknown, metadata: Record<string, unknown>): void {
    if (scope.ended) return;
    scope.ended = true;
    try {
      this.inStack(scope.stack, () =>
        this.nf.popScope(scope.handle, jsonCompatible(output), undefined, jsonCompatible(metadata)),
      );
    } catch (error) {
      this.logger.warn?.(`nemo-relay failed to close live scope: ${toMessage(error)}`);
    }
  }

  private closeSession(session: SessionRecord, reason: string, durationMs?: number): void {
    this.popLiveScope(
      session,
      { reason },
      {
        outcome: reason === 'error' ? 'error' : 'success',
        ...(durationMs === undefined ? {} : { duration_ms: durationMs }),
      },
    );
    if (session.sessionId) this.sessionsById.delete(session.sessionId);
    if (session.sessionKey) this.sessionsByKey.delete(session.sessionKey);
    this.sessionRecords.delete(session);
  }

  private async closeRunChildren(runId: string, reason: string): Promise<void> {
    for (const key of [...this.tools.keys()]) {
      if (this.tools.get(key)?.run.runId === runId) this.abandonTool(key, reason);
    }
    if (this.fallback.has(runId)) this.abandonFallback(runId, reason);
    for (const record of [...this.managed.values()]) {
      if (record.run.runId === runId) await this.abandonManaged(record, reason);
    }
  }

  private async abandonRun(runId: string, reason: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) return;
    this.runs.delete(runId);
    run.session.activeRuns.delete(runId);
    await this.closeRunChildren(runId, reason);
    this.popLiveScope(run, { abandoned: true, reason }, { outcome: 'error', abandoned: true });
    this.counters.abandoned += 1;
  }

  private abandonTool(key: string, reason: string): void {
    const record = this.tools.get(key);
    if (!record) return;
    try {
      this.inStack(record.run.stack, () =>
        this.nf.toolCallEnd(record.handle, {
          result: null,
          annotation: { outcome: 'error', abandoned: true, reason },
        }),
      );
    } catch (error) {
      this.logger.warn?.(`nemo-relay failed to abandon tool handle: ${toMessage(error)}`);
    }
    this.tools.delete(key);
    this.toolOrigins.delete(key);
    this.counters.abandoned += 1;
  }

  private abandonFallback(runId: string, reason: string): void {
    const record = this.fallback.get(runId);
    if (!record) return;
    try {
      this.inStack(record.run.stack, () =>
        this.nf.llmCallEnd(record.handle, { abandoned: true, reason }, undefined, {
          outcome: 'error',
          abandoned: true,
        }),
      );
    } catch (error) {
      this.logger.warn?.(`nemo-relay failed to abandon fallback LLM handle: ${toMessage(error)}`);
    }
    this.fallback.delete(runId);
    this.counters.abandoned += 1;
  }

  private async abandonManaged(record: ManagedCallRecord, reason: string): Promise<void> {
    if (!this.managed.has(record.id) || record.abandoning) return;
    record.abandoning = true;
    this.managed.delete(record.id);
    this.counters.managedLlmFailed += 1;
    record.cancel?.();
    try {
      await record.stream?.close();
    } catch (error) {
      this.logger.warn?.(`nemo-relay failed to close managed LLM stream: ${toMessage(error)}`);
    } finally {
      this.counters.abandoned += 1;
    }
  }

  private recordToolOrigins(runId: string, managedCallId: string, result: unknown): void {
    const record = asRecordOrUndefined(result);
    const content = Array.isArray(record?.content) ? record.content : [];
    for (const item of content) {
      const tool = asRecordOrUndefined(item);
      if (tool?.type === 'toolCall' && typeof tool.id === 'string') {
        this.toolOrigins.set(toolKey(runId, tool.id), { managedCallId, startedAt: Date.now() });
      }
    }
  }

  private resolveSpawnTool(tool: ToolRecord, result: unknown): void {
    const keys = collectStrings(result);
    for (const edge of this.subagentEdges.values()) {
      if (!edge.spawnAmbiguous || edge.requesterRun.runId !== tool.run.runId) continue;
      if (keys.has(edge.childSessionKey)) {
        edge.spawnAmbiguous = false;
        edge.spawningToolCallId = tool.toolCallId;
        const deferred = this.deferredSessions.get(edge.childSessionKey);
        if (deferred) {
          this.openSession(deferred.sessionId, deferred.sessionKey, edge);
          this.deferredSessions.delete(edge.childSessionKey);
        }
        this.notifyEdge(edge.childSessionKey);
      }
    }
  }

  private findSession(sessionId?: string, sessionKey?: string): SessionRecord | undefined {
    const byId = sessionId ? this.sessionsById.get(sessionId) : undefined;
    const byKey = sessionKey ? this.sessionsByKey.get(sessionKey) : undefined;
    if (byId && byKey && byId !== byKey) return undefined;
    return byId ?? byKey;
  }

  private uniqueRun(session?: SessionRecord): RunRecord | undefined {
    if (!session || session.activeRuns.size !== 1) return undefined;
    return this.runs.get([...session.activeRuns][0] ?? '');
  }

  private async waitForEdge(sessionKey: string): Promise<void> {
    if (this.edgeReady(sessionKey)) return;
    await new Promise<void>((resolve) => {
      const waiters = this.edgeWaiters.get(sessionKey) ?? new Set();
      waiters.add(resolve);
      this.edgeWaiters.set(sessionKey, waiters);
      const timer = setTimeout(() => {
        waiters.delete(resolve);
        resolve();
      }, SUBAGENT_GATE_MS);
      timer.unref();
    });
  }

  private edgeReady(sessionKey: string): boolean {
    const edge = this.subagentEdges.get(sessionKey);
    return edge !== undefined && !edge.spawnAmbiguous;
  }

  private notifyEdge(sessionKey: string): void {
    if (!this.edgeReady(sessionKey)) return;
    const waiters = this.edgeWaiters.get(sessionKey);
    if (!waiters) return;
    this.edgeWaiters.delete(sessionKey);
    for (const resolve of waiters) resolve();
  }

  private enforceBounds(): void {
    this.evictExpired();
    while (this.tools.size > MAX_INCOMPLETE) this.abandonTool(oldestKey(this.tools), 'capacity');
    while (this.fallback.size > MAX_INCOMPLETE) this.abandonFallback(oldestKey(this.fallback), 'capacity');
    while (this.runs.size > MAX_INCOMPLETE) void this.abandonRun(oldestKey(this.runs), 'capacity');
    while (this.managed.size > MAX_INCOMPLETE) {
      const record = this.managed.get(oldestKey(this.managed));
      if (record) void this.abandonManaged(record, 'capacity');
    }
    while (this.deferredSessions.size > MAX_INCOMPLETE) this.deferredSessions.delete(oldestKey(this.deferredSessions));
    while (this.subagentEdges.size > MAX_INCOMPLETE) this.subagentEdges.delete(oldestKey(this.subagentEdges));
    while (this.toolOrigins.size > MAX_INCOMPLETE) this.toolOrigins.delete(oldestKey(this.toolOrigins));
    while (this.sessionRecords.size > MAX_INCOMPLETE) {
      const session = oldestSession(this.sessionRecords);
      if (session) void this.abandonSession(session, 'capacity');
    }
  }

  private evictExpired(): void {
    const cutoff = Date.now() - INCOMPLETE_TTL_MS;
    for (const [key, record] of this.tools) if (record.startedAt < cutoff) this.abandonTool(key, 'ttl');
    for (const [key, record] of this.fallback) if (record.startedAt < cutoff) this.abandonFallback(key, 'ttl');
    for (const record of this.managed.values()) if (record.startedAt < cutoff) void this.abandonManaged(record, 'ttl');
    for (const [key, record] of this.runs) if (record.startedAt < cutoff) void this.abandonRun(key, 'ttl');
    for (const [key, record] of this.deferredSessions) if (record.startedAt < cutoff) this.deferredSessions.delete(key);
    for (const [key, record] of this.subagentEdges) if (record.startedAt < cutoff) this.subagentEdges.delete(key);
    for (const [key, record] of this.toolOrigins) if (record.startedAt < cutoff) this.toolOrigins.delete(key);
    for (const session of this.sessionRecords) {
      if (session.startedAt < cutoff) void this.abandonSession(session, 'ttl');
    }
  }

  private async abandonSession(session: SessionRecord, reason: string): Promise<void> {
    if (!this.sessionRecords.delete(session)) return;
    if (session.sessionId) this.sessionsById.delete(session.sessionId);
    if (session.sessionKey) this.sessionsByKey.delete(session.sessionKey);
    for (const runId of [...session.activeRuns]) await this.abandonRun(runId, reason);
    this.popLiveScope(session, { abandoned: true, reason }, { outcome: 'error', abandoned: true });
    this.counters.abandoned += 1;
  }

  private inStack<T>(stack: ScopeStack, callback: () => T): T {
    return this.nf.withScopeStack(stack, callback) as T;
  }

  private emitLineageDiagnostic(kind: string, sessionId: string | undefined, metadata: Record<string, unknown>): void {
    const session = this.findSession(sessionId, undefined);
    if (!session) {
      this.logger.warn?.(`nemo-relay lineage diagnostic: ${kind}`);
      return;
    }
    this.inStack(session.stack, () =>
      this.nf.event(
        `openclaw.lineage.${kind}`,
        session.handle,
        undefined,
        jsonCompatible({ ...metadata, session_id: session.sessionId }),
      ),
    );
  }

  private emitRunDiagnostic(run: RunRecord, kind: string, metadata: Record<string, unknown>): void {
    this.inStack(run.stack, () =>
      this.nf.event(
        `openclaw.lineage.${kind}`,
        run.handle,
        undefined,
        jsonCompatible({ ...metadata, run_id: run.runId }),
      ),
    );
  }
}

function block(reason: string) {
  return {
    outcome: 'block' as const,
    reason,
    message: 'NeMo Relay could not establish deterministic live execution lineage.',
  };
}

function toolKey(runId: string, toolCallId: string): string {
  return `${runId}\u0000${toolCallId}`;
}

function isSubagentKey(sessionKey: string): boolean {
  return sessionKey.includes(':subagent:') || sessionKey.includes(':acp:');
}

function asJsonRecord(value: unknown, source: string): Record<string, unknown> {
  const result = asRecordOrUndefined(jsonCompatible(value));
  if (!result) throw new Error(`${source} returned a non-object tool request`);
  return result;
}

function asRecordOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Drop non-JSON runtime objects without retaining OpenClaw callbacks or credentials. */
export function jsonCompatible(value: unknown): unknown {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(jsonCompatible).filter((item) => item !== undefined);
  if (typeof value === 'object') {
    if (value instanceof AbortSignal) return undefined;
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const compatible = jsonCompatible(item);
      if (compatible !== undefined) output[key] = compatible;
    }
    return output;
  }
  return undefined;
}

function collectStrings(value: unknown, output = new Set<string>(), depth = 0): Set<string> {
  if (depth > 6) return output;
  if (typeof value === 'string') output.add(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, output, depth + 1);
  else if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) collectStrings(item, output, depth + 1);
  }
  return output;
}

function oldestKey<T extends { startedAt: number }>(records: Map<string, T>): string {
  let selected = '';
  let time = Number.POSITIVE_INFINITY;
  for (const [key, record] of records) {
    if (record.startedAt < time) {
      selected = key;
      time = record.startedAt;
    }
  }
  return selected;
}

function oldestSession(records: Set<SessionRecord>): SessionRecord | undefined {
  let selected: SessionRecord | undefined;
  for (const record of records) {
    if (!selected || record.startedAt < selected.startedAt) selected = record;
  }
  return selected;
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
