import { Hono } from "hono";
import { SettingKey } from "../../config/settings-keys.js";
import { expandMcpConfig, parseMcpConfig } from "../../domain/mcp-config.js";
import { logger } from "../../pkg/logger.js";
import type { AdminEnv } from "./deps.js";
import type { McpStatus } from "../../mastra/mcp/manager.js";
import { upsertSetting } from "./setting-write.js";

const log = logger.child({ mod: "admin-mcp" });

/** Admin wire shape: `servers` is published as `status` (plan contract). */
function statusPayload(status: McpStatus) {
  return { ready: status.ready, refreshing: status.refreshing, status: status.servers };
}

/**
 * Admin router for admin-managed HTTP MCP servers (mounted at /admin/api/mcp).
 *
 * Contract:
 *  - `GET /`           → `{ config, ready, refreshing, status }`
 *  - `PUT /`           → validate → store `mcp_servers` → invalidate cache →
 *                        force refresh → `{ ok, config, ready, refreshing, status, warnings }`
 *  - `POST /test`      → probe a candidate config WITHOUT saving it
 *  - `POST /refresh`   → force re-discovery of the SAVED config
 *
 * Errors are `{ error: string }` (400 on schema problems only); per-server
 * connection failures are part of the 200 status payload. Error strings never
 * echo header values or URLs (they may carry secrets).
 */
export function mcpRoutes(): Hono<AdminEnv> {
  const r = new Hono<AdminEnv>();

  /** Current config + live status. `config` is the stored raw value (admin-only). */
  r.get("/", async (c) => {
    const { settings, mcp } = c.var.deps;
    const config = await settings.getMcpServers();
    return c.json({ config, ...statusPayload(mcp.getStatus()) });
  });

  /** Validate + persist the config, then reconnect immediately. */
  r.put("/", async (c) => {
    const { db, settings, mcp } = c.var.deps;
    const body = await c.req.json().catch(() => undefined);
    const parsed = parseMcpConfig(body);
    if (!parsed.ok) {
      log.warn({ adminUserId: c.var.adminUserId }, "MCP config validation failed");
      return c.json({ error: parsed.error }, 400);
    }

    await upsertSetting(db, SettingKey.McpServers, parsed.config);
    settings.invalidate();
    await mcp.refresh({ force: true });

    const expanded = expandMcpConfig(parsed.config);
    const warnings = [...expanded.warnings, ...(expanded.error ? [expanded.error] : [])];
    return c.json({
      ok: true,
      config: parsed.config,
      ...statusPayload(mcp.getStatus()),
      warnings,
    });
  });

  /** Probe a candidate config (no DB write, live snapshot untouched). */
  r.post("/test", async (c) => {
    const { mcp } = c.var.deps;
    const body = await c.req.json().catch(() => undefined);
    const parsed = parseMcpConfig(body);
    if (!parsed.ok) {
      log.warn({ adminUserId: c.var.adminUserId }, "MCP test validation failed");
      return c.json({ error: parsed.error }, 400);
    }

    const { servers, warnings } = await mcp.test(parsed.config);
    return c.json({ ok: true, status: servers, warnings });
  });

  /** Force re-discovery of the saved config (e.g. after the remote server redeployed). */
  r.post("/refresh", async (c) => {
    const { mcp } = c.var.deps;
    await mcp.refresh({ force: true });
    return c.json({ ok: true, ...statusPayload(mcp.getStatus()) });
  });

  return r;
}
