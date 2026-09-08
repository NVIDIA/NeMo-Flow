// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Lazy loading boundary for the in-process NeMo Relay runtime. */
import type * as NemoRelayRuntime from 'nemo-relay-node';
import type * as NemoRelayAdaptive from 'nemo-relay-node/adaptive';
import type * as NemoRelayPluginHost from 'nemo-relay-node/plugin';

type NemoRelayRuntimeKeys =
  | 'ScopeType'
  | 'createScopeStack'
  | 'createScopeStackFromPropagation'
  | 'currentScopeStack'
  | 'withScopeStack'
  | 'pushScope'
  | 'popScope'
  | 'event'
  | 'llmCall'
  | 'llmCallEnd'
  | 'llmStreamCallExecute'
  | 'pushStreamChunk'
  | 'pushStreamChunkAsync'
  | 'endStream'
  | 'failStream'
  | 'toolCall'
  | 'toolCallEnd'
  | 'toolConditionalExecution'
  | 'toolRequestIntercepts';

type NemoRelayPluginHostKeys = 'defaultConfig' | 'validate' | 'initialize';
type NemoRelayAdaptiveKeys = 'ADAPTIVE_PLUGIN_KIND' | 'ComponentSpec';

export type ConfigDiagnostic = NemoRelayPluginHost.ConfigDiagnostic;
export type PluginHostActivation = NemoRelayPluginHost.PluginHostActivation;
export type NemoRelayRuntimeModule = Omit<Pick<typeof NemoRelayRuntime, NemoRelayRuntimeKeys>, 'ScopeType'> & {
  ScopeType: {
    Agent: Parameters<typeof NemoRelayRuntime.pushScope>[1];
    Function: Parameters<typeof NemoRelayRuntime.pushScope>[1];
  };
  flushSubscribers?: typeof NemoRelayRuntime.flushSubscribers;
};
export type NemoRelayPluginHostModule = Pick<typeof NemoRelayPluginHost, NemoRelayPluginHostKeys>;
export type NemoRelayAdaptiveModule = Pick<typeof NemoRelayAdaptive, NemoRelayAdaptiveKeys>;

export type NemoRelayModules = {
  nf: NemoRelayRuntimeModule;
  pluginHost: NemoRelayPluginHostModule;
  adaptive: NemoRelayAdaptiveModule;
};

export type NemoRelayModuleLoader = () => Promise<NemoRelayModules>;

/** Load only the public Relay APIs used by the OpenClaw integration. */
export const defaultNemoRelayModuleLoader: NemoRelayModuleLoader = async () => {
  const [nf, pluginHost, adaptive] = await Promise.all([
    import('nemo-relay-node'),
    import('nemo-relay-node/plugin'),
    import('nemo-relay-node/adaptive'),
  ]);
  return {
    nf: nf as NemoRelayRuntimeModule,
    pluginHost: pluginHost as NemoRelayPluginHostModule,
    adaptive: adaptive as NemoRelayAdaptiveModule,
  };
};
