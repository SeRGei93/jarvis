import { MCPClient, type MastraMCPServerDefinition } from "@mastra/mcp";
import type { ToolsInput } from "@mastra/core/agent";
import type { SettingsService } from "../../config/settings.js";
import {
  expandMcpConfig,
  isHttpServerUrl,
  isMcpToolName,
  stableMcpConfigKey,
  type McpConfig,
  type ResolvedMcpServer,
} from "../../domain/mcp-config.js";
import { logger } from "../../pkg/logger.js";

const log = logger.child({ mod: "mcp-manager" });

/** Per-server status shown in the admin UI (and returned by `/test`). */
export interface McpServerStatus {
  name: string;
  enabled: boolean;
  connected: boolean;
  toolCount: number;
  /** Fully namespaced tool names (`<server>_<tool>`). */
  tools: string[];
  /** Connection/discovery failure reason (truncated, never contains secrets). */
  error?: string;
  /** Discovery duration for this server, when the SDK reports it. */
  durationMs?: number;
}

export interface McpStatus {
  /** True once the first refresh (successful or not) has completed. */
  ready: boolean;
  /** True while a refresh pass is running. */
  refreshing: boolean;
  servers: McpServerStatus[];
}

/** Subset of `MCPClient` the manager needs — injectable for tests (no network). */
export interface McpClientLike {
  listToolsetsWithErrors(options?: { perServerTimeoutMs?: number }): Promise<{
    toolsets: Record<string, Record<string, unknown> | undefined>;
    errors: Record<string, string>;
    durations?: Record<string, number>;
  }>;
  disconnect(): Promise<void>;
}

export interface McpClientFactoryOptions {
  /** Generation-scoped SDK client id (see `MCPClient`'s instance cache). */
  id: string;
  servers: Record<string, MastraMCPServerDefinition>;
  timeout: number;
}

export type McpClientFactory = (options: McpClientFactoryOptions) => McpClientLike;

export interface McpManagerOptions {
  settings: SettingsService;
  /**
   * Client factory. Defaults to a real `MCPClient` (process hooks disabled —
   * shutdown is owned by `server.ts`). Tests inject a fake to stay offline.
   */
  factory?: McpClientFactory;
  /** Discovery timeout per server (cold servers need more than the SDK's 3s connect). */
  discoveryTimeoutMs?: number;
  /** Connection-phase timeout passed to every server definition. */
  connectTimeoutMs?: number;
  /**
   * Delay before disconnecting a replaced client, so in-flight tool calls from
   * the previous generation can finish. 0 = disconnect immediately.
   */
  disposeGraceMs?: number;
}

/** Trade-off defaults: 60s per tool call, 10s discovery, 5s disposal grace. */
const DEFAULT_DISCOVERY_TIMEOUT_MS = 10_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_DISPOSE_GRACE_MS = 5_000;
/** Default per-tool-call timeout handed to the SDK client. */
const DEFAULT_TOOL_TIMEOUT_MS = 60_000;
/** Status error text is capped so a stack trace never floods the admin JSON. */
const MAX_ERROR_LENGTH = 500;

/** Discovery outcome shared by the live refresh and the ephemeral `/test` path. */
interface DiscoveryResult {
  toolsets: Record<string, Record<string, unknown> | undefined>;
  errors: Record<string, string>;
  durations: Record<string, number>;
}

/** Default factory: the real SDK client, process hooks off (we own shutdown). */
function defaultFactory(options: McpClientFactoryOptions): McpClientLike {
  const client = new MCPClient({
    id: options.id,
    servers: options.servers,
    timeout: options.timeout,
    registerProcessHooks: false,
  });
  return client as unknown as McpClientLike;
}

function errorText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.length > MAX_ERROR_LENGTH ? `${text.slice(0, MAX_ERROR_LENGTH)}…` : text;
}

/** A disabled server still appears in the status list (so the UI can show it). */
function disabledStatus(name: string): McpServerStatus {
  return { name, enabled: false, connected: false, toolCount: 0, tools: [] };
}

/**
 * Owns the HTTP MCP connection(s) configured from the admin Mini App.
 *
 * Lifecycle:
 *  - `refresh()` reads `settings.mcp_servers`, expands `${ENV}`, and performs ONE
 *    `listToolsetsWithErrors` discovery call (toolsets are already grouped per
 *    server, so no second pass is needed).
 *  - The SDK client is generation-scoped (`jarvis-admin-mcp-<n>`): a changed
 *    config builds a NEW client, swaps it in, and retires the old one after a
 *    short grace period. Reusing an id would make the SDK disconnect the cached
 *    instance synchronously inside the constructor, aborting in-flight tool calls.
 *  - Refreshes are serialized; a request arriving mid-pass is coalesced into one
 *    follow-up pass (latest-wins) so an admin save is never dropped.
 *  - `close()` disconnects every client (live + retiring) and makes later
 *    refreshes no-ops.
 *
 * Logging: only WARN/ERROR, and never the config itself — no headers, no header
 * values, no URLs with query secrets. Server names + error text only.
 */
export class McpManager {
  private readonly settings: SettingsService;
  private readonly factory: McpClientFactory;
  private readonly discoveryTimeoutMs: number;
  private readonly connectTimeoutMs: number;
  private readonly disposeGraceMs: number;

  private client: McpClientLike | null = null;
  /** Retired clients waiting out their grace period → their timer. */
  private readonly retiring = new Map<McpClientLike, NodeJS.Timeout>();
  /** Config key of the live client (null = none). */
  private configKey: string | null = null;
  private generation = 0;
  private testGeneration = 0;

  private tools: ToolsInput = {};
  private statuses: McpServerStatus[] = [];
  private ready = false;
  private refreshing = false;
  private closed = false;

  // Serialized refresh queue: any number of callers, at most one in-flight pass
  // plus one coalesced follow-up.
  private scheduler: Promise<void> | null = null;
  private pending = false;
  private pendingForce = false;
  private waiters: Array<() => void> = [];

  constructor(options: McpManagerOptions) {
    this.settings = options.settings;
    this.factory = options.factory ?? defaultFactory;
    this.discoveryTimeoutMs = options.discoveryTimeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.disposeGraceMs = options.disposeGraceMs ?? DEFAULT_DISPOSE_GRACE_MS;
  }

  /** Current tool snapshot for the orchestrator (synchronous, replaced wholesale). */
  getTools(): ToolsInput {
    return this.tools;
  }

  getStatus(): McpStatus {
    return {
      ready: this.ready,
      refreshing: this.refreshing,
      servers: this.statuses.map((s) => ({ ...s, tools: [...s.tools] })),
    };
  }

  /**
   * Re-read the config and (re)discover tools. `force` re-discovers even when
   * the resolved config is unchanged (manual refresh / post-save).
   */
  refresh(options: { force?: boolean } = {}): Promise<void> {
    if (this.closed) return Promise.resolve();
    const force = options.force === true;
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
      this.pending = true;
      this.pendingForce = this.pendingForce || force;
      this.startScheduler();
    });
  }

  /**
   * Probe a candidate config WITHOUT touching the live snapshot: used by the
   * admin "Проверить" button. Only `enabled !== false` servers are connected;
   * the ephemeral client is always disconnected.
   */
  async test(config: McpConfig): Promise<{ servers: McpServerStatus[]; warnings: string[] }> {
    const expanded = expandMcpConfig(config);
    const warnings = [...expanded.warnings];
    if (expanded.error) warnings.push(expanded.error);

    const { definitions, errors: definitionErrors } = this.buildDefinitions(expanded.servers);
    if (Object.keys(definitions).length === 0) {
      const { statuses } = this.buildSnapshot(expanded.servers, definitionErrors, {});
      return { servers: statuses, warnings };
    }

    // Unique id per call: the SDK caches instances by id, and a test must never
    // reuse (or disconnect) anything the live manager owns.
    const id = `jarvis-admin-mcp-test-${++this.testGeneration}`;
    const client = this.factory({ id, servers: definitions, timeout: DEFAULT_TOOL_TIMEOUT_MS });
    try {
      const discovered = await this.discoverSafely(client, expanded.servers);
      return { servers: this.buildSnapshot(expanded.servers, definitionErrors, discovered).statuses, warnings };
    } finally {
      await client
        .disconnect()
        .catch((err) => log.warn({ reason: errorText(err) }, "MCP test client disconnect failed"));
    }
  }

  /** Disconnect every client; later refreshes are no-ops. Safe to call twice. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    this.refreshing = false;
    this.tools = {};
    this.statuses = [];
    this.configKey = null;

    // Release anyone awaiting a refresh that will never run.
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve();

    for (const timer of this.retiring.values()) clearTimeout(timer);
    const clients = [...this.retiring.keys()];
    this.retiring.clear();
    if (this.client) {
      clients.push(this.client);
      this.client = null;
    }

    await Promise.allSettled(clients.map((c) => c.disconnect()));
    log.debug({ clients: clients.length }, "MCP manager closed");
  }

  // ── internals ────────────────────────────────────────────────────────────

  /** Start the drain loop if it is not already running. */
  private startScheduler(): void {
    if (this.scheduler || this.closed) return;
    this.scheduler = this.drain()
      .catch((err) => log.warn({ reason: errorText(err) }, "MCP refresh pass failed"))
      .finally(() => {
        this.scheduler = null;
        // A caller may have arrived between the loop exit and this finally.
        if (this.pending && !this.closed) this.startScheduler();
      });
  }

  /** Run passes until no caller is waiting; each pass resolves its own waiters. */
  private async drain(): Promise<void> {
    while (!this.closed) {
      const force = this.pendingForce;
      this.pending = false;
      this.pendingForce = false;
      const waiters = this.waiters;
      this.waiters = [];
      this.refreshing = true;

      try {
        await this.runOnce(force);
      } catch (err) {
        log.warn({ reason: errorText(err) }, "MCP refresh failed");
      } finally {
        for (const resolve of waiters) resolve();
      }

      // Another caller arrived during the pass → run exactly one more pass.
      if (this.pending && !this.closed) continue;
      break;
    }
    this.refreshing = false;
  }

  /** One refresh pass: read config → reuse/rebuild the client → discover → swap. */
  private async runOnce(force: boolean): Promise<void> {
    const config = await this.settings.getMcpServers();
    const expanded = expandMcpConfig(config);
    for (const warning of expanded.warnings) log.warn({ warning }, "MCP config warning");
    if (expanded.error) log.warn({ reason: expanded.error }, "MCP config error");

    const key = stableMcpConfigKey(expanded.servers);

    // Skip-if-unchanged: no client churn, no discovery, no status reset.
    if (!force && this.ready && key === this.configKey) {
      log.debug("MCP config unchanged; skipping refresh");
      return;
    }

    const { definitions, errors: definitionErrors } = this.buildDefinitions(expanded.servers);

    // Nothing enabled (or every enabled URL is unusable): drop the live client.
    if (Object.keys(definitions).length === 0) {
      this.retire(this.client, "no enabled servers");
      this.client = null;
      this.configKey = key;
      this.tools = {};
      this.statuses = this.buildSnapshot(expanded.servers, definitionErrors, {}).statuses;
      this.ready = true;
      log.debug({ servers: expanded.servers.length }, "MCP refresh with no enabled servers");
      return;
    }

    // Unchanged config + live client: re-discover on it (force path).
    // Changed config: build a NEW generation-scoped client and retire the old one.
    if (!this.client || key !== this.configKey) {
      const generation = ++this.generation;
      const client = this.factory({
        id: `jarvis-admin-mcp-${generation}`,
        servers: definitions,
        timeout: DEFAULT_TOOL_TIMEOUT_MS,
      });
      this.retire(this.client, "config changed");
      this.client = client;
      this.configKey = key;
    }

    const discovered = await this.discoverSafely(this.client, expanded.servers);

    // Always replace the snapshot: on a total failure the old tools must NOT be
    // served (they may point at a disconnected client).
    const { tools, statuses } = this.buildSnapshot(expanded.servers, definitionErrors, discovered);
    this.tools = tools;
    this.statuses = statuses;
    this.ready = true;
    log.debug(
      { servers: statuses.filter((s) => s.enabled).length, tools: Object.keys(tools).length },
      "MCP refresh complete",
    );
  }

  /** Map resolved servers → SDK definitions; unparseable URLs become per-server errors. */
  private buildDefinitions(servers: readonly ResolvedMcpServer[]): {
    definitions: Record<string, MastraMCPServerDefinition>;
    errors: Map<string, string>;
  } {
    const definitions: Record<string, MastraMCPServerDefinition> = {};
    const errors = new Map<string, string>();
    for (const server of servers) {
      if (!server.enabled) continue;
      if (!isHttpServerUrl(server.url)) {
        // No URL in the message: it may carry query-string secrets.
        errors.set(server.name, "invalid server url");
        continue;
      }
      try {
        definitions[server.name] = {
          url: new URL(server.url),
          // Only send headers when present; an empty object is harmless but noisy.
          ...(Object.keys(server.headers).length > 0
            ? { requestInit: { headers: server.headers } }
            : {}),
          timeout: server.timeoutMs,
          // SDK default is 3s — too short for a cold remote server.
          connectTimeout: this.connectTimeoutMs,
          enableServerLogs: false,
          forwardInstructions: false,
          ...(server.allowedHosts && server.allowedHosts.length > 0
            ? { allowedHosts: server.allowedHosts }
            : {}),
        };
      } catch {
        // No URL in the message: it may carry query-string secrets.
        errors.set(server.name, "invalid server url");
      }
    }
    return { definitions, errors };
  }

  /** One discovery call for all configured servers (toolsets are pre-grouped). */
  private async discover(client: McpClientLike): Promise<DiscoveryResult> {
    const res = await client.listToolsetsWithErrors({ perServerTimeoutMs: this.discoveryTimeoutMs });
    return {
      toolsets: res.toolsets ?? {},
      errors: res.errors ?? {},
      durations: res.durations ?? {},
    };
  }

  /** Discovery that never throws: a failure becomes a per-server error. */
  private async discoverSafely(
    client: McpClientLike,
    servers: readonly ResolvedMcpServer[],
  ): Promise<DiscoveryResult> {
    try {
      return await this.discover(client);
    } catch (err) {
      log.warn({ reason: errorText(err) }, "MCP discovery failed");
      const errors: Record<string, string> = {};
      for (const server of servers) if (server.enabled) errors[server.name] = "discovery failed";
      return { toolsets: {}, errors, durations: {} };
    }
  }

  /**
   * Turn a discovery outcome into the tool map + per-server statuses. Disabled
   * servers keep a status row; failed servers report `connected: false` and an
   * error, and contribute no tools.
   */
  private buildSnapshot(
    servers: readonly ResolvedMcpServer[],
    definitionErrors: ReadonlyMap<string, string>,
    discovered: Partial<DiscoveryResult>,
  ): { tools: ToolsInput; statuses: McpServerStatus[] } {
    const tools: ToolsInput = {};
    const statuses: McpServerStatus[] = [];

    for (const server of servers) {
      if (!server.enabled) {
        statuses.push(disabledStatus(server.name));
        continue;
      }

      const error = definitionErrors.get(server.name) ?? discovered.errors?.[server.name];
      const names: string[] = [];
      if (!error) {
        for (const [toolName, tool] of Object.entries(discovered.toolsets?.[server.name] ?? {})) {
          const fullName = `${server.name}_${toolName}`;
          if (!isMcpToolName(fullName)) {
            log.warn({ server: server.name, tool: toolName }, "skipping MCP tool with an unusable name");
            continue;
          }
          tools[fullName] = tool as ToolsInput[string];
          names.push(fullName);
        }
      }

      statuses.push({
        name: server.name,
        enabled: true,
        connected: !error,
        toolCount: names.length,
        tools: names,
        ...(error ? { error: errorText(error) } : {}),
        ...(discovered.durations?.[server.name] != null
          ? { durationMs: discovered.durations[server.name] }
          : {}),
      });
      if (error) log.warn({ server: server.name, reason: errorText(error) }, "MCP server unavailable");
    }

    return { tools, statuses };
  }

  /**
   * Retire a replaced client: keep it alive briefly (unref'd timer) so in-flight
   * tool calls finish, then disconnect. Grace 0 disconnects immediately.
   */
  private retire(client: McpClientLike | null, reason: string): void {
    if (!client) return;

    if (this.disposeGraceMs <= 0) {
      void client
        .disconnect()
        .catch((err) => log.warn({ reason: errorText(err) }, "retired MCP client disconnect failed"));
      return;
    }

    const timer = setTimeout(() => {
      this.retiring.delete(client);
      void client
        .disconnect()
        .catch((err) => log.warn({ reason: errorText(err) }, "retired MCP client disconnect failed"));
    }, this.disposeGraceMs);
    timer.unref?.();
    this.retiring.set(client, timer);
    log.debug({ reason, graceMs: this.disposeGraceMs }, "MCP client retired");
  }
}
