// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { attachModelProviderRequestTransport } from 'openclaw/plugin-sdk/agent-harness-runtime';
import { buildProviderReplayFamilyHooks } from 'openclaw/plugin-sdk/provider-model-shared';
import { buildProviderStreamFamilyHooks } from 'openclaw/plugin-sdk/provider-stream-family';
import { buildProviderToolCompatFamilyHooks } from 'openclaw/plugin-sdk/provider-tools';
import type {
  OpenClawPluginApi,
  ProviderPlugin,
  ProviderResolveDynamicModelContext,
  ProviderRuntimeModel,
  ProviderWrapStreamFnContext,
} from 'openclaw/plugin-sdk/plugin-entry';

import type { NemoRelayOpenClawConfig } from './config.js';
import { jsonCompatible, type LiveLineageCoordinator, type RunRecord } from './lineage.js';
import type { NemoRelayRuntimeModule } from './modules.js';

export const NEMO_RELAY_PROVIDER = 'nemo-relay';

const OPENAI_REPLAY_HOOKS = buildProviderReplayFamilyHooks({ family: 'openai-compatible' });
const ANTHROPIC_REPLAY_HOOKS = buildProviderReplayFamilyHooks({ family: 'native-anthropic-by-model' });
const GOOGLE_REPLAY_HOOKS = buildProviderReplayFamilyHooks({ family: 'google-gemini' });
const OPENROUTER_REPLAY_HOOKS = buildProviderReplayFamilyHooks({ family: 'passthrough-gemini' });
const OPENAI_TOOL_HOOKS = buildProviderToolCompatFamilyHooks('openai');
const GOOGLE_TOOL_HOOKS = buildProviderToolCompatFamilyHooks('gemini');

/** Register provider control-plane surfaces while OpenClaw is in plugin registration mode. */
export function registerNemoRelayProvider(
  api: OpenClawPluginApi,
  config: NemoRelayOpenClawConfig,
  getRuntimeProvider: () => NemoRelayProvider | undefined,
): void {
  const compatibility = createProviderCompatibilityHooks();
  api.registerProvider({
    id: NEMO_RELAY_PROVIDER,
    label: 'NeMo Relay',
    auth: [],
    resolveDynamicModel: (ctx) => {
      const provider = getRuntimeProvider();
      if (!provider) throw new Error('NeMo Relay runtime is not ready');
      return provider.resolveDynamicModel(ctx);
    },
    wrapStreamFn: (ctx) => {
      const provider = getRuntimeProvider();
      if (!provider) throw new Error('NeMo Relay runtime is not ready');
      return provider.wrapStreamFn(ctx);
    },
    ...compatibility,
  });
  api.registerModelCatalogProvider({
    provider: NEMO_RELAY_PROVIDER,
    kinds: ['text'],
    staticCatalog: () =>
      config.routing.favorites.map((model) => ({
        kind: 'text' as const,
        provider: NEMO_RELAY_PROVIDER,
        model,
        label: `${NEMO_RELAY_PROVIDER}/${model}`,
        source: 'configured' as const,
        configured: true,
      })),
  });
}

type StreamFn = NonNullable<ProviderWrapStreamFnContext['streamFn']>;
type Model = ProviderRuntimeModel;
type CallContext = Parameters<StreamFn>[1];
type CallOptions = NonNullable<Parameters<StreamFn>[2]>;
type UpstreamStream = Awaited<ReturnType<StreamFn>>;
type AssistantEvent = UpstreamStream extends AsyncIterable<infer T> ? T : never;
type AssistantResult = Awaited<ReturnType<UpstreamStream['result']>>;
type RelayStream = Awaited<ReturnType<NemoRelayRuntimeModule['llmStreamCallExecute']>>;

type VerifiedRoute = {
  ref: string;
  provider: string;
  modelId: string;
  api: string;
  model: Model;
};

type RouteSnapshot = {
  requested: VerifiedRoute;
  routes: Map<string, VerifiedRoute>;
};

type ManagedRequestContent = {
  selectedModel: string;
  systemPrompt?: string;
  messages: unknown[];
  tools?: unknown[];
  options: Record<string, unknown>;
  lineage: {
    sessionId?: string;
    runId: string;
    requestId?: string;
    managedCallId: string;
  };
};

/** Registers the dynamic `nemo-relay/*` model namespace and live stream wrapper. */
export class NemoRelayProvider {
  private readonly api: OpenClawPluginApi;
  private readonly config: NemoRelayOpenClawConfig;
  private nf: NemoRelayRuntimeModule | undefined;
  private lineage: LiveLineageCoordinator | undefined;
  private readonly snapshots = new Map<string, RouteSnapshot>();

  constructor(
    api: OpenClawPluginApi,
    config: NemoRelayOpenClawConfig,
    nf?: NemoRelayRuntimeModule,
    lineage?: LiveLineageCoordinator,
  ) {
    this.api = api;
    this.config = config;
    this.nf = nf;
    this.lineage = lineage;
  }

  attachRuntime(nf: NemoRelayRuntimeModule, lineage: LiveLineageCoordinator): void {
    this.nf = nf;
    this.lineage = lineage;
  }

  detachRuntime(): void {
    this.nf = undefined;
    this.lineage = undefined;
  }

  resolveDynamicModel(ctx: ProviderResolveDynamicModelContext): Model {
    const requestedRef = normalizeNestedReference(ctx.modelId);
    const routes = new Map<string, VerifiedRoute>();
    for (const model of ctx.modelRegistry.getAll()) {
      const candidate = verifyModel(model);
      if (candidate) routes.set(candidate.ref, candidate);
    }
    const parsed = parseUpstreamReference(requestedRef);
    const exact = ctx.modelRegistry.find(parsed.provider, parsed.modelId);
    const requested = exact ? verifyModel(exact) : undefined;
    if (!requested) {
      throw new Error(`unsupported or unknown NeMo Relay route: ${NEMO_RELAY_PROVIDER}/${requestedRef}`);
    }
    routes.set(requested.ref, requested);
    this.snapshots.set(requestedRef, { requested, routes });
    return {
      ...requested.model,
      id: requestedRef,
      name: `${NEMO_RELAY_PROVIDER}/${requested.ref}`,
      provider: NEMO_RELAY_PROVIDER,
    };
  }

  wrapStreamFn(ctx: ProviderWrapStreamFnContext): StreamFn {
    const nf = this.nf;
    const lineage = this.lineage;
    if (!nf || !lineage) throw new Error('NeMo Relay runtime is not ready for managed execution');
    const original = ctx.streamFn;
    if (!original) throw new Error('OpenClaw did not provide an original stream function to NeMo Relay');
    const nestedRef = normalizeNestedReference(ctx.modelId);
    const snapshot = this.snapshots.get(nestedRef);
    if (!snapshot) throw new Error(`missing verified route snapshot for ${NEMO_RELAY_PROVIDER}/${nestedRef}`);

    return async (_selectedModel, callContext, options = {}) => {
      const run = lineage.resolveManagedRun(options.sessionId, options.requestId);
      const call = lineage.startManagedCall(run, options.requestId);
      const cancellation = new AbortController();
      const executionOptions: CallOptions = {
        ...options,
        signal: options.signal ? AbortSignal.any([options.signal, cancellation.signal]) : cancellation.signal,
      };
      const request = encodeManagedRequest(
        `${NEMO_RELAY_PROVIDER}/${snapshot.requested.ref}`,
        callContext,
        options,
        run,
        call.id,
      );
      let finalResult: AssistantResult | undefined;
      let producerError: unknown;
      let finished = false;

      const finish = (error?: unknown) => {
        if (finished) return;
        finished = true;
        lineage.finishManagedCall(call, finalResult, error);
      };

      try {
        const relayStream = await this.inRunStack(run, () =>
          nf.llmStreamCallExecute(
            NEMO_RELAY_PROVIDER,
            request,
            (wrapper: unknown) => {
              const envelope = decodeRelayEnvelope(wrapper);
              const providerStack = nf.currentScopeStack();
              void nf.withScopeStack(providerStack, async () => {
                let upstream: UpstreamStream | undefined;
                let iterator: AsyncIterator<AssistantEvent> | undefined;
                let providerHandle: ReturnType<NemoRelayRuntimeModule['pushScope']> | undefined;
                let succeeded = false;
                let consumerClosed = false;
                try {
                  const decoded = decodeManagedRequest(envelope.request);
                  const route = snapshot.routes.get(stripRelayPrefix(decoded.selectedModel));
                  if (!route)
                    throw new Error(`Relay request interceptor selected an unverified route: ${decoded.selectedModel}`);
                  providerHandle = nf.pushScope(
                    `openclaw.provider.${route.provider}`,
                    nf.ScopeType.Function,
                    undefined,
                    undefined,
                    undefined,
                    {
                      upstream_provider: route.provider,
                      upstream_model: route.modelId,
                      upstream_api: route.api,
                      managed_llm_call_id: call.id,
                    },
                  );
                  const runtime = await this.resolveRuntimeExecution(route, ctx, executionOptions, decoded.options);
                  const upstreamStreamFn = wrapVerifiedUpstreamStream(route, original, ctx);
                  upstream = await upstreamStreamFn(runtime.model, decoded.context, runtime.options);
                  iterator = upstream[Symbol.asyncIterator]();
                  while (true) {
                    const next = await iterator.next();
                    if (next.done) break;
                    if (!(await nf.pushStreamChunkAsync(envelope.streamId, jsonCompatible(next.value)))) {
                      consumerClosed = true;
                      await iterator.return?.();
                      break;
                    }
                  }
                  if (consumerClosed || executionOptions.signal?.aborted) {
                    throw new Error('OpenClaw provider stream cancelled');
                  }
                  finalResult = await upstream.result();
                  succeeded = true;
                  nf.popScope(providerHandle, jsonCompatible(finalResult), undefined, { outcome: 'success' });
                  nf.endStream(envelope.streamId);
                } catch (error) {
                  producerError = error;
                  try {
                    await iterator?.return?.();
                  } finally {
                    try {
                      if (providerHandle) {
                        nf.popScope(providerHandle, undefined, undefined, {
                          outcome: 'error',
                          error: toMessage(error),
                        });
                      }
                    } finally {
                      nf.failStream(envelope.streamId, toMessage(error));
                    }
                  }
                } finally {
                  if (!succeeded && producerError === undefined) producerError = new Error('provider stream abandoned');
                }
              });
            },
            undefined,
            () => jsonCompatible(finalResult) ?? null,
            run.handle,
            undefined,
            {
              managed_llm_call_id: call.id,
              openclaw_run_id: run.runId,
            },
            {
              selected_model: `${NEMO_RELAY_PROVIDER}/${snapshot.requested.ref}`,
              upstream_provider: snapshot.requested.provider,
              upstream_model: snapshot.requested.modelId,
              upstream_api: snapshot.requested.api,
              openclaw_session_id: options.sessionId,
              openclaw_request_id: options.requestId,
            },
            `${NEMO_RELAY_PROVIDER}/${snapshot.requested.ref}`,
            (value) => decodeRelayAnnotatedRequest(value),
            (payload) => encodeInterceptedPayload(payload),
            (response) => response,
          ),
        );
        lineage.bindManagedStream(call, relayStream, () => cancellation.abort());
        return new ManagedAssistantStream(
          relayStream,
          () => finalResult,
          () => producerError,
          () => cancellation.abort(),
          finish,
        );
      } catch (error) {
        cancellation.abort();
        finish(error);
        throw error;
      }
    };
  }

  private async resolveRuntimeExecution(
    route: VerifiedRoute,
    ctx: ProviderWrapStreamFnContext,
    originalOptions: CallOptions,
    rewrittenOptions: Record<string, unknown>,
  ): Promise<{ model: Model; options: CallOptions }> {
    const auth = await this.api.runtime.modelAuth.getRuntimeAuthForModel({
      model: route.model,
      ...(ctx.config === undefined ? {} : { cfg: ctx.config }),
      ...(ctx.workspaceDir === undefined ? {} : { workspaceDir: ctx.workspaceDir }),
    });
    let model: Model = auth.baseUrl ? { ...route.model, baseUrl: auth.baseUrl } : { ...route.model };
    model = attachModelProviderRequestTransport(model, auth.request);
    const safeOptions = decodeSafeOptions(rewrittenOptions);
    return {
      model,
      options: {
        ...originalOptions,
        ...safeOptions,
        ...(auth.apiKey === undefined ? {} : { apiKey: auth.apiKey }),
      },
    };
  }

  private inRunStack<T>(run: RunRecord, callback: () => T): T {
    if (!this.nf) throw new Error('NeMo Relay runtime is not ready');
    return this.nf.withScopeStack(run.stack, callback) as T;
  }
}

class ManagedAssistantStream implements AsyncIterable<AssistantEvent> {
  private readonly relay: RelayStream;
  private readonly finalResult: () => AssistantResult | undefined;
  private readonly producerError: () => unknown;
  private readonly cancel: () => void;
  private readonly finish: (error?: unknown) => void;
  private done = false;
  private reading = false;

  constructor(
    relay: RelayStream,
    finalResult: () => AssistantResult | undefined,
    producerError: () => unknown,
    cancel: () => void,
    finish: (error?: unknown) => void,
  ) {
    this.relay = relay;
    this.finalResult = finalResult;
    this.producerError = producerError;
    this.cancel = cancel;
    this.finish = finish;
  }

  [Symbol.asyncIterator](): AsyncIterator<AssistantEvent> {
    return {
      next: () => this.next(),
      return: async () => {
        await this.close(new Error('OpenClaw stream consumer closed early'));
        return { done: true, value: undefined };
      },
    };
  }

  async result(): Promise<AssistantResult> {
    while (!this.done) await this.next();
    const error = this.producerError();
    if (error !== undefined) throw error;
    const result = this.finalResult();
    if (result === undefined) throw new Error('NeMo Relay stream completed without an assistant result');
    return result;
  }

  private async next(): Promise<IteratorResult<AssistantEvent>> {
    if (this.done) return { done: true, value: undefined };
    if (this.reading) throw new Error('NeMo Relay assistant stream does not support concurrent reads');
    this.reading = true;
    try {
      const chunk = await this.relay.next();
      if (chunk === null) {
        this.done = true;
        const error = this.producerError();
        this.finish(error);
        if (error !== undefined) throw error;
        return { done: true, value: undefined };
      }
      return { done: false, value: chunk as AssistantEvent };
    } catch (error) {
      this.done = true;
      this.finish(error);
      throw error;
    } finally {
      this.reading = false;
    }
  }

  private async close(error: unknown): Promise<void> {
    if (this.done) return;
    this.done = true;
    this.cancel();
    try {
      await this.relay.close();
    } finally {
      this.finish(error);
    }
  }
}

type CompatibilityHooks = Pick<
  ProviderPlugin,
  | 'buildReplayPolicy'
  | 'sanitizeReplayHistory'
  | 'validateReplayTurns'
  | 'normalizeToolSchemas'
  | 'inspectToolSchemas'
  | 'resolveReasoningOutputMode'
  | 'prepareExtraParams'
>;

function createProviderCompatibilityHooks(): CompatibilityHooks {
  return {
    buildReplayPolicy: (ctx) => {
      const hooks = ctx.modelId ? replayHooksFor(ctx.modelId) : undefined;
      const adapted = upstreamHookContext(ctx);
      if (!adapted) return undefined;
      return hooks?.buildReplayPolicy?.(adapted);
    },
    sanitizeReplayHistory: (ctx) => {
      const hooks = ctx.modelId ? replayHooksFor(ctx.modelId) : undefined;
      const adapted = upstreamHookContext(ctx);
      if (!adapted) return undefined;
      return hooks?.sanitizeReplayHistory?.(adapted);
    },
    validateReplayTurns: (ctx) => {
      const hooks = ctx.modelId ? replayHooksFor(ctx.modelId) : undefined;
      const adapted = upstreamHookContext(ctx);
      if (!adapted) return undefined;
      return hooks?.validateReplayTurns?.(adapted);
    },
    normalizeToolSchemas: (ctx) => {
      const hooks = ctx.modelId ? toolHooksFor(ctx.modelId) : undefined;
      const adapted = upstreamHookContext(ctx);
      if (!adapted) return undefined;
      return hooks?.normalizeToolSchemas?.(adapted);
    },
    inspectToolSchemas: (ctx) => {
      const hooks = ctx.modelId ? toolHooksFor(ctx.modelId) : undefined;
      const adapted = upstreamHookContext(ctx);
      if (!adapted) return undefined;
      return hooks?.inspectToolSchemas?.(adapted);
    },
    resolveReasoningOutputMode: () => 'native',
    prepareExtraParams: (ctx) => {
      const parsed = parseUpstreamReference(ctx.modelId);
      const api = String(ctx.model?.api ?? '');
      if ((parsed.provider === 'openai' || parsed.provider === 'openai-codex') && api.includes('responses')) {
        const transport = ctx.extraParams?.transport;
        if (!['auto', 'sse', 'websocket', 'websocket-cached'].includes(String(transport))) {
          return { ...ctx.extraParams, transport: 'sse' };
        }
      }
      return ctx.extraParams;
    },
  };
}

function replayHooksFor(modelId: string) {
  const { provider } = parseUpstreamReference(modelId);
  if (provider === 'openai' || provider === 'openai-codex') return OPENAI_REPLAY_HOOKS;
  if (provider === 'anthropic') return ANTHROPIC_REPLAY_HOOKS;
  if (provider === 'google' || provider === 'google-vertex') return GOOGLE_REPLAY_HOOKS;
  if (provider === 'openrouter') return OPENROUTER_REPLAY_HOOKS;
  return undefined;
}

function toolHooksFor(modelId: string) {
  const { provider } = parseUpstreamReference(modelId);
  if (provider === 'google' || provider === 'google-vertex') return GOOGLE_TOOL_HOOKS;
  if (provider === 'openai' || provider === 'openai-codex' || provider === 'openrouter') return OPENAI_TOOL_HOOKS;
  return undefined;
}

function upstreamHookContext<T extends { provider?: string; modelId?: string }>(
  ctx: T,
): (T & { provider: string; modelId: string }) | undefined {
  if (!ctx.modelId) return undefined;
  const parsed = parseUpstreamReference(ctx.modelId);
  const contextualModel = (ctx as T & { model?: Model }).model;
  return {
    ...ctx,
    provider: parsed.provider,
    modelId: parsed.modelId,
    ...(contextualModel ? { model: { ...contextualModel, provider: parsed.provider, id: parsed.modelId } } : {}),
  } as T & { provider: string; modelId: string };
}

function wrapVerifiedUpstreamStream(
  route: VerifiedRoute,
  original: StreamFn,
  ctx: ProviderWrapStreamFnContext,
): StreamFn {
  const family =
    route.provider === 'google' || route.provider === 'google-vertex'
      ? 'google-thinking'
      : route.provider === 'openrouter'
        ? 'openrouter-thinking'
        : (route.provider === 'openai' || route.provider === 'openai-codex') && route.api.includes('responses')
          ? 'openai-responses-defaults'
          : undefined;
  if (!family) return original;
  const hooks = buildProviderStreamFamilyHooks(family);
  return (
    hooks.wrapStreamFn?.({
      ...ctx,
      provider: route.provider,
      modelId: route.modelId,
      model: route.model,
      streamFn: original,
    }) ?? original
  );
}

function verifyModel(model: Model): VerifiedRoute | undefined {
  const api = String(model.api);
  const allowed =
    (model.provider === 'openai' && ['openai-responses', 'openai-completions'].includes(api)) ||
    (model.provider === 'openai-codex' && api === 'openai-chatgpt-responses') ||
    (model.provider === 'anthropic' && api === 'anthropic-messages') ||
    (model.provider === 'google' && api === 'google-generative-ai') ||
    (model.provider === 'google-vertex' && api === 'google-vertex') ||
    (model.provider === 'openrouter' && api === 'openai-completions');
  if (!allowed || model.provider === NEMO_RELAY_PROVIDER) return undefined;
  return {
    ref: `${model.provider}/${model.id}`,
    provider: model.provider,
    modelId: model.id,
    api,
    model: { ...model },
  };
}

export function parseUpstreamReference(value: string): { provider: string; modelId: string } {
  const reference = stripRelayPrefix(value.trim());
  const slash = reference.indexOf('/');
  if (slash < 1 || slash === reference.length - 1) throw new Error('NeMo Relay models require provider/model syntax');
  const provider = reference.slice(0, slash);
  const modelId = reference.slice(slash + 1);
  if (provider === NEMO_RELAY_PROVIDER || modelId.startsWith(`${NEMO_RELAY_PROVIDER}/`)) {
    throw new Error('recursive nemo-relay model routes are not supported');
  }
  return { provider, modelId };
}

function normalizeNestedReference(value: string): string {
  const parsed = parseUpstreamReference(value);
  return `${parsed.provider}/${parsed.modelId}`;
}

function stripRelayPrefix(value: string): string {
  return value.startsWith(`${NEMO_RELAY_PROVIDER}/`) ? value.slice(NEMO_RELAY_PROVIDER.length + 1) : value;
}

function encodeManagedRequest(
  selectedModel: string,
  context: CallContext,
  options: CallOptions,
  run: RunRecord,
  managedCallId: string,
) {
  const content: ManagedRequestContent = {
    selectedModel,
    ...(context.systemPrompt === undefined ? {} : { systemPrompt: context.systemPrompt }),
    messages: (jsonCompatible(context.messages) as unknown[]) ?? [],
    ...(context.tools === undefined ? {} : { tools: jsonCompatible(context.tools) as unknown[] }),
    options: projectSafeOptions(options),
    lineage: {
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      runId: run.runId,
      ...(options.requestId === undefined ? {} : { requestId: options.requestId }),
      managedCallId,
    },
  };
  return {
    headers: {
      openclaw_run_id: run.runId,
      ...(options.sessionId === undefined ? {} : { openclaw_session_id: options.sessionId }),
      ...(options.requestId === undefined ? {} : { openclaw_request_id: options.requestId }),
      managed_llm_call_id: managedCallId,
    },
    content,
  };
}

function decodeRelayEnvelope(value: unknown): { request: unknown; streamId: number } {
  const record = asRecord(value, 'Relay stream envelope');
  const streamId = record.__nemo_relay_stream_id;
  if (typeof streamId !== 'number') throw new Error('Relay stream envelope is missing its stream id');
  return { request: record.__nemo_relay_native, streamId };
}

function decodeManagedRequest(value: unknown): ManagedRequestContent & { context: CallContext } {
  const request = asRecord(value, 'Relay LLM request');
  const content = asRecord(request.content, 'Relay LLM request content');
  if (typeof content.selectedModel !== 'string') throw new Error('Relay request is missing selectedModel');
  if (!Array.isArray(content.messages)) throw new Error('Relay request messages must be an array');
  const lineage = asRecord(content.lineage, 'Relay request lineage');
  if (typeof lineage.runId !== 'string' || typeof lineage.managedCallId !== 'string') {
    throw new Error('Relay request lineage is invalid');
  }
  const options = asRecord(content.options, 'Relay request options');
  const context: CallContext = {
    messages: content.messages as CallContext['messages'],
    ...(typeof content.systemPrompt === 'string' ? { systemPrompt: content.systemPrompt } : {}),
    ...(Array.isArray(content.tools) ? { tools: content.tools as NonNullable<CallContext['tools']> } : {}),
  };
  return {
    selectedModel: content.selectedModel,
    messages: content.messages,
    options,
    lineage: lineage as ManagedRequestContent['lineage'],
    context,
    ...(typeof content.systemPrompt === 'string' ? { systemPrompt: content.systemPrompt } : {}),
    ...(Array.isArray(content.tools) ? { tools: content.tools } : {}),
  };
}

function encodeInterceptedPayload(payload: unknown): unknown {
  const record = asRecord(payload, 'Relay codec payload');
  if ('annotated' in record && 'original' in record) {
    const annotated = asRecord(record.annotated, 'intercepted Relay request');
    const original = asRecord(record.original, 'original Relay request');
    const wire = decodeManagedRequest(original);
    const relayState = asRecord(annotated.nemo_relay, 'intercepted Relay state');
    const originalMessages = Array.isArray(relayState.originalMessages) ? relayState.originalMessages : wire.messages;
    const baselineMessages = Array.isArray(relayState.baselineMessages) ? relayState.baselineMessages : [];
    const annotatedMessages = Array.isArray(annotated.messages) ? annotated.messages : [];
    const messages = sameJson(annotatedMessages, baselineMessages)
      ? originalMessages
      : annotatedMessages.map(fromRelayMessage).filter((item) => item !== undefined);
    const content: ManagedRequestContent = {
      selectedModel: typeof annotated.model === 'string' ? annotated.model : wire.selectedModel,
      messages,
      options: {
        ...wire.options,
        ...optionsFromRelayParams(annotated.params),
      },
      lineage: wire.lineage,
      ...(typeof annotated.instructions === 'string'
        ? { systemPrompt: annotated.instructions }
        : wire.systemPrompt === undefined
          ? {}
          : { systemPrompt: wire.systemPrompt }),
      ...(Array.isArray(annotated.tools)
        ? { tools: annotated.tools.map(fromRelayTool).filter((item) => item !== undefined) }
        : wire.tools === undefined
          ? {}
          : { tools: wire.tools }),
    };
    return { ...original, content };
  }
  throw new Error('Relay codec encode payload is missing annotated/original values');
}

function decodeRelayAnnotatedRequest(value: unknown): Record<string, unknown> {
  const wire = decodeManagedRequest(value);
  const messages = wire.messages.map(toRelayMessage);
  return {
    model: wire.selectedModel,
    ...(wire.systemPrompt === undefined ? {} : { instructions: wire.systemPrompt }),
    messages,
    ...(wire.tools === undefined ? {} : { tools: wire.tools.map(toRelayTool) }),
    params: relayParamsFromOptions(wire.options),
    nemo_relay: {
      lineage: wire.lineage,
      options: wire.options,
      originalMessages: wire.messages,
      baselineMessages: messages,
    },
  };
}

function toRelayMessage(value: unknown): unknown {
  const message =
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  if (message?.role === 'user') {
    if (typeof message.content === 'string') return { role: 'user', content: message.content };
    if (Array.isArray(message.content)) {
      const parts = message.content.map((part) => {
        const record =
          part !== null && typeof part === 'object' && !Array.isArray(part)
            ? (part as Record<string, unknown>)
            : undefined;
        if (record?.type === 'text' && typeof record.text === 'string') return { type: 'text', text: record.text };
        if (record?.type === 'image') return { type: 'image', image: record };
        return { type: 'provider_native', provider: 'openclaw', kind: 'content', value: record ?? part };
      });
      return { role: 'user', content: parts };
    }
  }
  return { role: 'provider_native', provider: 'openclaw', kind: 'message', value: value ?? null };
}

function fromRelayMessage(value: unknown): unknown {
  const message =
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  if (!message) return undefined;
  if (message.role === 'provider_native' && message.provider === 'openclaw') return message.value;
  if (message.role === 'user') return { role: 'user', content: message.content, timestamp: Date.now() };
  return undefined;
}

function toRelayTool(value: unknown): unknown {
  const tool =
    value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  return {
    type: 'function',
    function: {
      name: typeof tool.name === 'string' ? tool.name : 'unknown',
      ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
      ...(tool.parameters === undefined ? {} : { parameters: tool.parameters }),
    },
  };
}

function fromRelayTool(value: unknown): unknown {
  const tool =
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  const fn =
    tool?.function !== null && typeof tool?.function === 'object' && !Array.isArray(tool.function)
      ? (tool.function as Record<string, unknown>)
      : undefined;
  if (tool?.type !== 'function' || typeof fn?.name !== 'string') return undefined;
  return {
    name: fn.name,
    description: typeof fn.description === 'string' ? fn.description : '',
    parameters: fn.parameters ?? { type: 'object', properties: {} },
  };
}

function relayParamsFromOptions(options: Record<string, unknown>): Record<string, unknown> {
  return {
    ...(typeof options.temperature === 'number' ? { temperature: options.temperature } : {}),
    ...(typeof options.maxTokens === 'number' ? { max_tokens: options.maxTokens } : {}),
    ...(Array.isArray(options.stop) ? { stop: options.stop } : {}),
  };
}

function optionsFromRelayParams(value: unknown): Record<string, unknown> {
  const params =
    value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  return {
    ...(typeof params.temperature === 'number' ? { temperature: params.temperature } : {}),
    ...(typeof params.max_tokens === 'number' ? { maxTokens: params.max_tokens } : {}),
    ...(Array.isArray(params.stop) ? { stop: params.stop } : {}),
  };
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function projectSafeOptions(options: CallOptions): Record<string, unknown> {
  const keys: Array<keyof CallOptions> = [
    'temperature',
    'maxTokens',
    'responseFormat',
    'stop',
    'transport',
    'cacheRetention',
    'sessionId',
    'requestId',
    'promptCacheKey',
    'asyncToolExecution',
    'timeoutMs',
    'maxRetryDelayMs',
    'metadata',
    'reasoning',
    'thinkingBudgets',
  ];
  const output: Record<string, unknown> = {};
  for (const key of keys) {
    const value = jsonCompatible(options[key]);
    if (value !== undefined) output[key] = value;
  }
  return output;
}

function decodeSafeOptions(value: Record<string, unknown>): Partial<CallOptions> {
  const projected = projectSafeOptions(value as CallOptions);
  return projected as Partial<CallOptions>;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
