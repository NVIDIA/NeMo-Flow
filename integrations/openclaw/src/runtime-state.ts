// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  OpenClawPluginApi,
  OpenClawPluginServiceContext,
  PluginLogger,
  PluginRuntimeLifecycleRegistration,
} from 'openclaw/plugin-sdk/plugin-entry';

import { parseConfig } from './config.js';
import type { RuntimeStatus } from './health.js';
import { LiveLineageCoordinator } from './lineage.js';
import {
  defaultNemoRelayModuleLoader,
  type ConfigDiagnostic,
  type NemoRelayModules,
  type NemoRelayModuleLoader,
  type PluginHostActivation,
} from './modules.js';
import { NemoRelayProvider, registerNemoRelayProvider } from './provider.js';
import type { RuntimeStateOptions, StartContext } from './types.js';

const SERVICE_ID = 'nemo-relay-runtime';
const LIFECYCLE_ID = 'nemo-relay-runtime-cleanup';
const STATUS_METHOD = 'nemoRelay.status';
type CleanupContext = Parameters<NonNullable<PluginRuntimeLifecycleRegistration['cleanup']>>[0];

/** Owns one in-process Relay runtime and its live OpenClaw lineage state. */
export class NemoRelayRuntimeState {
  private readonly api: OpenClawPluginApi;
  private readonly config: ReturnType<typeof parseConfig>;
  private readonly moduleLoader: NemoRelayModuleLoader;
  private statusValue: RuntimeStatus = { state: 'not_initialized' };
  private loadPromise?: Promise<NemoRelayModules>;
  private pluginHostActivation?: PluginHostActivation;
  private lineage?: LiveLineageCoordinator;
  private readonly provider: NemoRelayProvider;
  private startPromise?: Promise<void>;
  private started = false;
  private pluginHostInitialized = false;
  private lastStartContext?: StartContext;
  private beforeExitListener?: () => void;

  constructor(options: RuntimeStateOptions) {
    this.api = options.api;
    this.config = options.config;
    this.moduleLoader = options.moduleLoader ?? defaultNemoRelayModuleLoader;
    this.provider = new NemoRelayProvider(this.api, this.config);
  }

  getProvider(): NemoRelayProvider {
    return this.provider;
  }

  health() {
    return {
      status: this.statusValue,
      inProcess: true as const,
      providerPrefix: 'nemo-relay' as const,
      gateway: false as const,
      toolExecutionIntercepts: false as const,
      pluginHostInitialized: this.pluginHostInitialized,
      ...(this.lineage === undefined ? {} : { lineage: this.lineage.status() }),
    };
  }

  async start(ctx: StartContext): Promise<void> {
    this.lastStartContext = { ...ctx };
    if (this.started) return;
    if (this.startPromise) return await this.startPromise;
    this.startPromise = this.startInternal(ctx);
    try {
      await this.startPromise;
    } finally {
      delete this.startPromise;
    }
  }

  private async startInternal(ctx: StartContext): Promise<void> {
    let modules: NemoRelayModules;
    try {
      this.loadPromise ??= this.moduleLoader();
      modules = await this.loadPromise;
    } catch (error) {
      delete this.loadPromise;
      this.statusValue = { state: 'degraded', reason: `failed to load nemo-relay-node: ${toMessage(error)}` };
      ctx.logger.warn?.(this.statusValue.reason);
      return;
    }

    let degradedReason: string | undefined;
    try {
      const validation = modules.pluginHost.validate(
        this.config.plugins as Parameters<NemoRelayModules['pluginHost']['validate']>[0],
      );
      logDiagnostics(ctx.logger, validation.config.diagnostics);
      if (validation.config.diagnostics.some((item) => item.level === 'error')) {
        degradedReason = 'NeMo Relay plugin host configuration contains errors';
      } else {
        this.pluginHostActivation = await modules.pluginHost.initialize(
          this.config.plugins as Parameters<NemoRelayModules['pluginHost']['initialize']>[0],
        );
        const activationDiagnostics = this.pluginHostActivation.report.config.diagnostics;
        logDiagnostics(ctx.logger, activationDiagnostics);
        this.pluginHostInitialized = true;
        if (activationDiagnostics.some((item) => item.level === 'error')) {
          degradedReason = 'NeMo Relay plugin host initialization contains errors';
        }
      }
    } catch (error) {
      degradedReason = `failed to initialize NeMo Relay plugin host: ${toMessage(error)}`;
      ctx.logger.warn?.(degradedReason);
    }

    this.lineage = new LiveLineageCoordinator(modules.nf, this.config, ctx.logger);
    this.provider.attachRuntime(modules.nf, this.lineage);
    this.started = true;
    this.statusValue = degradedReason ? { state: 'degraded', reason: degradedReason } : { state: 'ready' };
    this.registerBeforeExit(ctx.logger);
  }

  async stop(reason: string, logger = this.api.logger): Promise<void> {
    if (['stopped', 'stopping', 'disabled'].includes(this.statusValue.state)) return;
    if (this.startPromise) await this.startPromise.catch(() => undefined);
    this.statusValue = { state: 'stopping', reason };
    this.removeBeforeExitListener();
    try {
      await this.lineage?.drain(reason);
    } catch (error) {
      logger.warn?.(`failed to drain NeMo Relay live lineage: ${toMessage(error)}`);
    }
    let pluginHostCloseFailure: string | undefined;
    if (this.pluginHostActivation) {
      try {
        await this.pluginHostActivation.close();
        delete this.pluginHostActivation;
        this.pluginHostInitialized = false;
      } catch (error) {
        pluginHostCloseFailure = `failed to close NeMo Relay plugin host: ${toMessage(error)}`;
        logger.warn?.(pluginHostCloseFailure);
      }
    }
    this.started = false;
    delete this.lineage;
    this.provider.detachRuntime();
    this.statusValue =
      pluginHostCloseFailure === undefined
        ? { state: 'stopped', reason }
        : { state: 'degraded', reason: pluginHostCloseFailure };
  }

  async cleanup(ctx: CleanupContext): Promise<void> {
    if (ctx.runId || ctx.sessionKey) return;
    await this.stop(ctx.reason);
  }

  registerHooks(): void {
    this.api.on('gateway_start', async (_event, ctx) => {
      await this.ensureStarted(ctx.workspaceDir);
    });
    this.api.on('gateway_stop', async (event) => {
      await this.stop(event.reason ?? 'gateway_stop');
    });
    this.api.on('session_start', async (event) => {
      await this.failOpen('session_start', undefined, (lineage) => lineage.sessionStart(event));
    });
    this.api.on('session_end', async (event) => {
      await this.failOpen('session_end', undefined, (lineage) => lineage.sessionEnd(event));
    });
    this.api.on('before_agent_run', async (_event, ctx) => {
      const lineage = await this.ensureLineage(ctx.workspaceDir);
      if (!lineage) {
        return ctx.modelProviderId === 'nemo-relay'
          ? {
              outcome: 'block' as const,
              reason: 'NeMo Relay runtime unavailable',
              message: 'NeMo Relay is unavailable, so managed execution was not started.',
            }
          : { outcome: 'pass' as const };
      }
      return await lineage.beforeAgentRun(ctx);
    });
    this.api.on('agent_end', async (event, ctx) => {
      await this.failOpen('agent_end', ctx.workspaceDir, (lineage) => lineage.agentEnd(event, ctx));
    });
    this.api.on('before_tool_call', async (event, ctx) => {
      const lineage = await this.ensureLineage();
      if (!lineage) {
        return { block: true, blockReason: 'NeMo Relay tool policy runtime is unavailable' };
      }
      return await lineage.beforeToolCall(event, ctx);
    });
    this.api.on('after_tool_call', async (event) => {
      await this.failOpen('after_tool_call', undefined, (lineage) => lineage.afterToolCall(event));
    });
    this.api.on('llm_input', async (event, ctx) => {
      await this.failOpen('llm_input', ctx.workspaceDir, (lineage) => lineage.fallbackInput(event));
    });
    this.api.on('llm_output', async (event, ctx) => {
      await this.failOpen('llm_output', ctx.workspaceDir, (lineage) => lineage.fallbackOutput(event));
    });
    this.api.on('subagent_spawned', async (event, ctx) => {
      await this.failOpen('subagent_spawned', undefined, (lineage) => lineage.subagentSpawned(event, ctx));
    });
    this.api.on('subagent_ended', async (event) => {
      await this.failOpen('subagent_ended', undefined, (lineage) => lineage.subagentEnded(event));
    });
  }

  private async failOpen(
    label: string,
    workspaceDir: string | undefined,
    callback: (lineage: LiveLineageCoordinator) => void | Promise<void>,
  ): Promise<void> {
    const lineage = await this.ensureLineage(workspaceDir);
    if (!lineage) return;
    try {
      await callback(lineage);
    } catch (error) {
      this.api.logger.warn?.(`nemo-relay ${label} instrumentation failed open: ${toMessage(error)}`);
    }
  }

  private async ensureLineage(workspaceDir?: string): Promise<LiveLineageCoordinator | undefined> {
    if (!this.lineage && this.statusValue.state !== 'stopping') await this.ensureStarted(workspaceDir);
    return this.lineage;
  }

  private async ensureStarted(workspaceDir?: string): Promise<void> {
    if (this.started) return;
    const existing = this.lastStartContext;
    await this.start(
      existing ?? {
        stateDir: this.api.runtime.state.resolveStateDir(),
        logger: this.api.logger,
        agentVersion: this.api.version ?? 'unknown',
        ...(workspaceDir === undefined ? {} : { workspaceDir }),
      },
    );
  }

  private registerBeforeExit(logger: PluginLogger): void {
    if (this.beforeExitListener) return;
    this.beforeExitListener = () => {
      void this.stop('beforeExit', logger);
    };
    process.on('beforeExit', this.beforeExitListener);
  }

  private removeBeforeExitListener(): void {
    if (!this.beforeExitListener) return;
    process.removeListener('beforeExit', this.beforeExitListener);
    delete this.beforeExitListener;
  }
}

/** Register the in-process provider, lifecycle hooks, service, and status method. */
export function registerNemoRelayPlugin(api: OpenClawPluginApi, moduleLoader?: NemoRelayModuleLoader): void {
  if (api.registrationMode !== 'full') return;
  let config: ReturnType<typeof parseConfig>;
  try {
    config = parseConfig(api.pluginConfig);
  } catch (error) {
    api.logger.warn?.(`nemo-relay disabled because plugin config is invalid: ${toMessage(error)}`);
    return;
  }
  if (!config.enabled) {
    api.logger.info?.('nemo-relay disabled by plugin config');
    return;
  }
  for (const field of config.deprecatedFields) {
    api.logger.warn?.(`nemo-relay config.${field} is deprecated and ignored`);
  }

  const runtime = new NemoRelayRuntimeState(
    moduleLoader === undefined ? { api, config } : { api, config, moduleLoader },
  );
  registerNemoRelayProvider(api, config, () => runtime.getProvider());
  api.registerService({
    id: SERVICE_ID,
    start: (ctx: OpenClawPluginServiceContext) =>
      runtime.start({
        stateDir: ctx.stateDir,
        logger: ctx.logger,
        agentVersion: api.version ?? 'unknown',
        ...(ctx.workspaceDir === undefined ? {} : { workspaceDir: ctx.workspaceDir }),
      }),
    stop: (ctx: OpenClawPluginServiceContext) => runtime.stop('service_stop', ctx.logger),
  });
  api.registerRuntimeLifecycle({
    id: LIFECYCLE_ID,
    description: 'Drain NeMo Relay live handles in leaf-to-root order',
    cleanup: (ctx) => runtime.cleanup(ctx),
  });
  api.registerGatewayMethod?.(STATUS_METHOD, ({ respond }) => respond(true, runtime.health()), {
    scope: 'operator.admin',
  });
  runtime.registerHooks();
}

function logDiagnostics(logger: PluginLogger, diagnostics: ConfigDiagnostic[]): void {
  for (const diagnostic of diagnostics) {
    const message = `${diagnostic.component ? `${diagnostic.component}: ` : ''}${diagnostic.code}: ${diagnostic.message}`;
    if (diagnostic.level === 'error') logger.warn?.(message);
    else logger.info?.(message);
  }
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
