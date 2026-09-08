// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { OpenClawPluginConfigSchema } from 'openclaw/plugin-sdk/plugin-entry';

import manifest from '../openclaw.plugin.json' with { type: 'json' };

export type NemoRelayPluginHostConfig = {
  version: number;
  components: unknown[];
  [key: string]: unknown;
};

export type NemoRelayOpenClawConfig = {
  enabled: boolean;
  plugins: NemoRelayPluginHostConfig;
  routing: { favorites: string[] };
  fallback: { enabled: boolean };
  deprecatedFields: string[];
};

const DEFAULT_PLUGIN_HOST_CONFIG: NemoRelayPluginHostConfig = { version: 1, components: [] };

export const NEMO_RELAY_OPENCLAW_JSON_SCHEMA = manifest.configSchema;

export const DEFAULT_CONFIG: NemoRelayOpenClawConfig = {
  enabled: true,
  plugins: DEFAULT_PLUGIN_HOST_CONFIG,
  routing: { favorites: [] },
  fallback: { enabled: true },
  deprecatedFields: [],
};

export const nemoRelayConfigSchema = {
  safeParse(value: unknown) {
    try {
      return { success: true, data: parseConfig(value) };
    } catch (error) {
      return {
        success: false,
        error: {
          issues: [{ path: [], message: error instanceof Error ? error.message : String(error) }],
        },
      };
    }
  },
  jsonSchema: NEMO_RELAY_OPENCLAW_JSON_SCHEMA,
} satisfies OpenClawPluginConfigSchema;

/** Parse plugin JSON into the normalized in-process provider configuration. */
export function parseConfig(value: unknown): NemoRelayOpenClawConfig {
  const raw = asRecord(value, 'config', true);
  rejectRemovedFields(raw);
  rejectUnknownFields(raw, 'config', ['enabled', 'plugins', 'routing', 'fallback', 'backend', 'correlation']);

  if (raw.backend !== undefined && raw.backend !== 'hooks') {
    throw new Error('config.backend is deprecated and must be "hooks" when present');
  }
  if (raw.correlation !== undefined) {
    asRecord(raw.correlation, 'correlation', false);
  }

  const routing = asRecord(raw.routing, 'routing', true);
  rejectUnknownFields(routing, 'routing', ['favorites']);
  const fallback = asRecord(raw.fallback, 'fallback', true);
  rejectUnknownFields(fallback, 'fallback', ['enabled']);
  return {
    enabled: optionalBoolean(raw.enabled, 'enabled') ?? DEFAULT_CONFIG.enabled,
    plugins: parsePluginHostConfig(raw.plugins),
    routing: { favorites: parseFavorites(routing.favorites) },
    fallback: {
      enabled: optionalBoolean(fallback.enabled, 'fallback.enabled') ?? DEFAULT_CONFIG.fallback.enabled,
    },
    deprecatedFields: ['backend', 'correlation'].filter((field) => raw[field] !== undefined),
  };
}

function parseFavorites(value: unknown): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error('routing.favorites must be an array');
  }
  const favorites = new Set<string>();
  for (const [index, item] of value.entries()) {
    if (typeof item !== 'string') {
      throw new Error(`routing.favorites[${index}] must be a string`);
    }
    const reference = item.trim();
    const slash = reference.indexOf('/');
    if (slash < 1 || slash === reference.length - 1) {
      throw new Error(`routing.favorites[${index}] must use provider/model syntax`);
    }
    if (reference.slice(0, slash) === 'nemo-relay') {
      throw new Error(`routing.favorites[${index}] must reference an upstream provider`);
    }
    favorites.add(reference);
  }
  return [...favorites];
}

function parsePluginHostConfig(value: unknown): NemoRelayPluginHostConfig {
  if (value === undefined) {
    return { ...DEFAULT_PLUGIN_HOST_CONFIG, components: [] };
  }
  const record = asRecord(value, 'plugins', false);
  const version = optionalNumber(record.version, 'plugins.version') ?? 1;
  const components = record.components ?? [];
  if (!Array.isArray(components)) {
    throw new Error('plugins.components must be an array');
  }
  return { ...record, version, components: [...components] };
}

function asRecord(value: unknown, path: string, optional: boolean): Record<string, unknown> {
  if (value === undefined && optional) {
    return {};
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error(`${path} must be an object`);
}

function rejectRemovedFields(raw: Record<string, unknown>): void {
  if (raw.nemoRelay !== undefined) {
    throw new Error('nemoRelay.pluginConfig was removed; use top-level plugins instead');
  }
  if (raw.atif !== undefined || raw.telemetry !== undefined) {
    throw new Error('configure observability through plugins.components');
  }
}

function rejectUnknownFields(raw: Record<string, unknown>, path: string, allowed: string[]): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(raw)) {
    if (!allowedSet.has(key)) {
      throw new Error(`${path}.${key} is not supported`);
    }
  }
}

function optionalBoolean(value: unknown, path: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'boolean') {
    throw new Error(`${path} must be a boolean`);
  }
  return value;
}

function optionalNumber(value: unknown, path: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${path} must be a finite number`);
  }
  return value;
}
