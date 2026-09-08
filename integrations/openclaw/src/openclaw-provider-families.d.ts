// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

declare module 'openclaw/plugin-sdk/provider-model-shared' {
  import type { ProviderPlugin } from 'openclaw/plugin-sdk/plugin-entry';

  export function buildProviderReplayFamilyHooks(options: {
    family: 'openai-compatible' | 'native-anthropic-by-model' | 'google-gemini' | 'passthrough-gemini';
  }): Pick<ProviderPlugin, 'buildReplayPolicy' | 'sanitizeReplayHistory' | 'validateReplayTurns'>;
}

declare module 'openclaw/plugin-sdk/provider-tools' {
  import type { ProviderPlugin } from 'openclaw/plugin-sdk/plugin-entry';

  export function buildProviderToolCompatFamilyHooks(
    family: 'openai' | 'gemini',
  ): Pick<ProviderPlugin, 'normalizeToolSchemas' | 'inspectToolSchemas'>;
}

declare module 'openclaw/plugin-sdk/provider-stream-family' {
  import type { ProviderPlugin } from 'openclaw/plugin-sdk/plugin-entry';

  export function buildProviderStreamFamilyHooks(
    family: 'openai-responses-defaults' | 'google-thinking' | 'openrouter-thinking',
  ): Pick<ProviderPlugin, 'wrapStreamFn'>;
}
