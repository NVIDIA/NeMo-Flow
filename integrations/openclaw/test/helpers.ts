// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { PluginLogger, ProviderRuntimeModel } from 'openclaw/plugin-sdk/plugin-entry';

import type { NemoRelayModules, NemoRelayRuntimeModule } from '../src/modules.js';

type FakeHandle = {
  uuid: string;
  name: string;
  scopeType: number;
  attributes: number;
  parentUuid: string | null;
  data: unknown;
  metadata: unknown;
};
type FakeStack = { rootUuid?: string | undefined; top?: FakeHandle | undefined };

export type FakeRuntime = NemoRelayRuntimeModule & {
  calls: {
    pushScope: Array<{ handle: FakeHandle; metadata: unknown }>;
    popScope: Array<{ handle: FakeHandle; output: unknown; metadata: unknown }>;
    llmCall: Array<Record<string, unknown>>;
    llmCallEnd: Array<Record<string, unknown>>;
    llmStreamCallExecute: Array<Record<string, unknown>>;
    toolCall: Array<Record<string, unknown>>;
    toolCallEnd: Array<Record<string, unknown>>;
    conditional: Array<Record<string, unknown>>;
    requestIntercepts: Array<Record<string, unknown>>;
  };
  rewriteAnnotated?: (value: Record<string, unknown>) => Record<string, unknown>;
  rewriteTool?: (value: Record<string, unknown>) => Record<string, unknown>;
  rewriteChunk?: (value: unknown) => unknown;
};

export function createFakeRuntime(): FakeRuntime {
  let nextId = 0;
  let current: FakeStack = {};
  const channels = new Map<number, FakeChannel>();
  const calls: FakeRuntime['calls'] = {
    pushScope: [],
    popScope: [],
    llmCall: [],
    llmCallEnd: [],
    llmStreamCallExecute: [],
    toolCall: [],
    toolCallEnd: [],
    conditional: [],
    requestIntercepts: [],
  };
  const nf = {
    ScopeType: { Agent: 0, Function: 1, Tool: 2, Llm: 3, Custom: 9 },
    calls,
    createScopeStack: () => ({}),
    createScopeStackFromPropagation: (context: { rootUuid?: string; parentUuid: string }) => ({
      rootUuid: context.rootUuid,
      top: fakeHandle(context.parentUuid, 'propagated-parent', 0, null),
    }),
    currentScopeStack: () => current,
    withScopeStack: <T>(stack: FakeStack, callback: () => T): T => {
      const previous = current;
      current = stack;
      try {
        const result = callback();
        if (result && typeof (result as unknown as PromiseLike<unknown>).then === 'function') {
          return Promise.resolve(result).finally(() => {
            current = previous;
          }) as T;
        }
        current = previous;
        return result;
      } catch (error) {
        current = previous;
        throw error;
      }
    },
    pushScope: (
      name: string,
      scopeType: number,
      parent?: FakeHandle,
      _attributes?: number,
      data?: unknown,
      metadata?: unknown,
    ) => {
      const handle = fakeHandle(`scope-${++nextId}`, name, scopeType, parent?.uuid ?? current.top?.uuid ?? null);
      handle.data = data;
      handle.metadata = metadata;
      current.top = handle;
      calls.pushScope.push({ handle, metadata });
      return handle;
    },
    popScope: (handle: FakeHandle, output?: unknown, _timestamp?: number, metadata?: unknown) => {
      calls.popScope.push({ handle, output, metadata });
      if (current.top?.uuid === handle.uuid) current.top = undefined;
    },
    event: () => undefined,
    llmCall: (name: string, request: unknown, parent?: FakeHandle, ...rest: unknown[]) => {
      const handle = fakeHandle(`llm-${++nextId}`, name, 3, parent?.uuid ?? null);
      calls.llmCall.push({ name, request, parent, rest, handle });
      return handle;
    },
    llmCallEnd: (handle: FakeHandle, response: unknown, data?: unknown, metadata?: unknown) => {
      calls.llmCallEnd.push({ handle, response, data, metadata });
    },
    toolCall: (name: string, args: unknown, parent?: FakeHandle, ...rest: unknown[]) => {
      const handle = fakeHandle(`tool-${++nextId}`, name, 2, parent?.uuid ?? null);
      calls.toolCall.push({ name, args, parent, rest, handle });
      return handle;
    },
    toolCallEnd: (handle: FakeHandle, result: unknown, data?: unknown, metadata?: unknown) => {
      calls.toolCallEnd.push({ handle, result, data, metadata });
    },
    toolConditionalExecution: async (name: string, args: unknown) => {
      calls.conditional.push({ name, args });
    },
    toolRequestIntercepts: async (name: string, args: unknown) => {
      calls.requestIntercepts.push({ name, args });
      return nf.rewriteTool?.(args as Record<string, unknown>) ?? args;
    },
    pushStreamChunk: (streamId: number, chunk: unknown) => {
      const channel = channels.get(streamId);
      if (!channel || channel.done) return false;
      channel.push(nf.rewriteChunk?.(chunk) ?? chunk);
      return true;
    },
    pushStreamChunkAsync: async (streamId: number, chunk: unknown) => nf.pushStreamChunk(streamId, chunk),
    endStream: (streamId: number) => channels.get(streamId)?.end(),
    failStream: (streamId: number, message: string) => channels.get(streamId)?.fail(new Error(message)),
    llmStreamCallExecute: async (
      name: string,
      request: unknown,
      func: (value: unknown) => unknown,
      _collector?: unknown,
      finalizer?: () => unknown,
      parent?: FakeHandle,
      ...rest: unknown[]
    ) => {
      const decoded = rest[4] ? (rest[4] as (value: unknown) => Record<string, unknown>)(request) : request;
      const annotated = nf.rewriteAnnotated?.(decoded as Record<string, unknown>) ?? decoded;
      const rewritten = rest[5] ? (rest[5] as (value: unknown) => unknown)({ annotated, original: request }) : request;
      const id = ++nextId;
      const channel = new FakeChannel(finalizer);
      channels.set(id, channel);
      const llmHandle = fakeHandle(`managed-llm-${id}`, name, 3, parent?.uuid ?? null);
      const callbackStack: FakeStack = { rootUuid: current.rootUuid, top: llmHandle };
      calls.llmStreamCallExecute.push({ name, request, rewritten, parent, rest, handle: llmHandle });
      nf.withScopeStack(callbackStack, () => func({ __nemo_relay_native: rewritten, __nemo_relay_stream_id: id }));
      return channel;
    },
    flushSubscribers: async () => undefined,
  } as unknown as FakeRuntime;
  return nf;
}

class FakeChannel {
  private values: unknown[] = [];
  private waiters: Array<() => void> = [];
  private error?: Error;
  done = false;
  private readonly finalizer: (() => unknown) | undefined;

  constructor(finalizer?: () => unknown) {
    this.finalizer = finalizer;
  }

  push(value: unknown): void {
    this.values.push(value);
    this.wake();
  }

  end(): void {
    this.done = true;
    this.finalizer?.();
    this.wake();
  }

  fail(error: Error): void {
    this.error = error;
    this.done = true;
    this.wake();
  }

  async next(): Promise<unknown | null> {
    while (this.values.length === 0 && !this.done) await new Promise<void>((resolve) => this.waiters.push(resolve));
    if (this.values.length) return this.values.shift();
    if (this.error) throw this.error;
    return null;
  }

  async close(): Promise<void> {
    this.done = true;
    this.wake();
  }

  private wake(): void {
    for (const resolve of this.waiters.splice(0)) resolve();
  }
}

function fakeHandle(uuid: string, name: string, scopeType: number, parentUuid: string | null): FakeHandle {
  return { uuid, name, scopeType, attributes: 0, parentUuid, data: null, metadata: null };
}

export function model(provider: string, id: string, api: string): ProviderRuntimeModel {
  return {
    provider,
    id,
    name: `${provider}/${id}`,
    api,
    baseUrl: `https://${provider}.example.test`,
    reasoning: true,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 8_192,
  };
}

export function createModules(nf = createFakeRuntime()): NemoRelayModules {
  const report = { config: { diagnostics: [] }, dynamic_plugins: [] };
  return {
    nf,
    pluginHost: {
      defaultConfig: () => ({ version: 1, components: [] }),
      validate: () => report,
      initialize: async () => ({
        report,
        isActive: true,
        close: async () => undefined,
        [Symbol.asyncDispose]: async () => undefined,
      }),
    } as unknown as NemoRelayModules['pluginHost'],
    adaptive: { ADAPTIVE_PLUGIN_KIND: 'adaptive', ComponentSpec: class {} } as unknown as NemoRelayModules['adaptive'],
  };
}

export const logger: PluginLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };
