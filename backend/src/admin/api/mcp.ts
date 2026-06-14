import { Hono } from "hono";
import { z } from "zod";
import { settings } from "../../db/schema.js";
import { SettingKey, type McpServers } from "../../config/settings-keys.js";
import { logger } from "../../pkg/logger.js";
import type { AdminEnv } from "./deps.js";

const log = logger.child({ mod: "admin-mcp" });

/** Per ROADMAP §5/§9 only the `search` MCP server is supported. */
const SUPPORTED_SERVERS = new Set(["search"]);

const serverSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()),
  env: z.record(z.string(), z.string()).optional(),
});

const serversSchema = z.record(z.string(), serverSchema);

function zodError(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}

/**
 * Admin config router for MCP servers (mounted at /admin/api/mcp). Only the
 * `search` server is accepted; the write upserts the `mcp_servers` settings row
 * and invalidates the cache so the live chat picks up the change.
 */
export function mcpRoutes(): Hono<AdminEnv> {
  const r = new Hono<AdminEnv>();

  r.get("/", async (c) => {
    const { settings: svc } = c.var.deps;
    log.debug({ adminUserId: c.var.adminUserId }, "read mcp servers");
    return c.json(await svc.getMcpServers());
  });

  r.put("/", async (c) => {
    const { db, settings: svc } = c.var.deps;
    const body = await c.req.json().catch(() => undefined);
    const parsed = serversSchema.safeParse(body);
    if (!parsed.success) {
      log.warn({ adminUserId: c.var.adminUserId }, "mcp validation failed");
      return c.json({ error: zodError(parsed.error) }, 400);
    }

    const names = Object.keys(parsed.data);
    const unsupported = names.filter((n) => !SUPPORTED_SERVERS.has(n));
    if (unsupported.length > 0) {
      log.warn({ adminUserId: c.var.adminUserId, unsupported }, "unsupported mcp server(s)");
      return c.json(
        { error: `unsupported MCP server(s): ${unsupported.join(", ")} (only 'search' is allowed)` },
        400,
      );
    }

    const value: McpServers = parsed.data;
    const now = new Date();
    await db
      .insert(settings)
      .values({ key: SettingKey.McpServers, value, updatedAt: now })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } });
    svc.invalidate();
    log.info(
      { adminUserId: c.var.adminUserId, key: SettingKey.McpServers, servers: names },
      "mcp servers updated",
    );
    return c.json({ ok: true, value });
  });

  return r;
}
