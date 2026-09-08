// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseConfig } from '../src/config.js';

describe('OpenClaw configuration', () => {
  it('applies in-process provider defaults', () => {
    assert.deepEqual(parseConfig(undefined), {
      enabled: true,
      plugins: { version: 1, components: [] },
      routing: { favorites: [] },
      fallback: { enabled: true },
      deprecatedFields: [],
    });
  });

  it('deduplicates favorites while preserving nested model ids', () => {
    const config = parseConfig({
      routing: { favorites: ['openai/gpt-5.4', 'openrouter/vendor/model', 'openai/gpt-5.4'] },
    });
    assert.deepEqual(config.routing.favorites, ['openai/gpt-5.4', 'openrouter/vendor/model']);
  });

  it('accepts legacy fields for one release as deprecated no-ops', () => {
    assert.deepEqual(parseConfig({ backend: 'hooks', correlation: { recordTtlMs: 10 } }).deprecatedFields, [
      'backend',
      'correlation',
    ]);
  });

  it('rejects recursion, malformed favorites, and unknown configuration', () => {
    assert.throws(() => parseConfig({ routing: { favorites: ['nemo-relay/openai/gpt'] } }), /upstream provider/);
    assert.throws(() => parseConfig({ routing: { favorites: ['gpt'] } }), /provider\/model/);
    assert.throws(() => parseConfig({ endpoint: 'http://gateway' }), /not supported/);
    assert.throws(() => parseConfig({ capture: {} }), /not supported/);
  });
});
