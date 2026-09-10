// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { OpenClawPluginApi, OpenClawPluginServiceContext } from 'openclaw/plugin-sdk/plugin-entry';

import type { NemoRelayOpenClawConfig } from './config.js';
import type { NemoRelayModuleLoader } from './modules.js';

export type RuntimeStateOptions = {
  api: OpenClawPluginApi;
  config: NemoRelayOpenClawConfig;
  moduleLoader?: NemoRelayModuleLoader;
};

export type StartContext = {
  stateDir: string;
  workspaceDir?: string;
  logger: OpenClawPluginServiceContext['logger'];
  agentVersion: string;
};
