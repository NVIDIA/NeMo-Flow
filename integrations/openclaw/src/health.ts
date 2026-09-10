// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { LineageStatus } from './lineage.js';

export type RuntimeStatus =
  | { state: 'not_initialized' | 'ready' | 'stopping' | 'stopped' | 'disabled'; reason?: string }
  | { state: 'degraded'; reason: string };

export type NemoRelayHealth = {
  status: RuntimeStatus;
  inProcess: true;
  providerPrefix: 'nemo-relay';
  gateway: false;
  toolExecutionIntercepts: false;
  pluginHostInitialized: boolean;
  lineage?: LineageStatus;
};
