import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import * as schema from "./schema.js";
import {
  settings,
  models as modelsTable,
  subscriptionPlans,
  skills as skillsTable,
  prompts as promptsTable,
} from "./schema.js";
import { SettingKey, type McpServerConfig, type McpServers } from "../config/settings-keys.js";
import { logger } from "../pkg/logger.js";

const log = logger.child({ mod: "seed" });

/** backend/seed — bundled copy of the Go project's config.yaml / skills / prompts. */
export const SEED_DIR = fileURLToPath(new URL("../../seed", import.meta.url));

export type Db = LibSQLDatabase<typeof schema>;

interface RawConfig {
  default_model: string;
  router_model: string;
  embedding_model: string;
  error_correction_model: string;
  speech_model?: string;
  synthesizer_model?: string;
  models: string[];
  telegram?: { allowed_users?: number[] };
  agent?: {
    max_history?: number;
    default_temperature?: number;
    rag?: { top_k?: number };
    // NOTE: memory_extraction.* and rag.enabled are dead Go config — NOT seeded.
  };
  timeouts?: { llm_request?: string; http_client?: string; llm_activity?: string };
  mcp_servers?: Record<string, McpServerConfig>;
}

export function loadSeedConfig(): RawConfig {
  return parseYaml(readFileSync(join(SEED_DIR, "config.yaml"), "utf8")) as RawConfig;
}

// We keep only the `search` MCP server; the `memory` knowledge-graph server is
// dropped (memory is consolidated into built-in storage). See ROADMAP §5/§9.
function searchOnly(servers?: Record<string, McpServerConfig>): McpServers {
  return servers?.search ? { search: servers.search } : {};
}

async function seedSettings(db: Db, cfg: RawConfig): Promise<void> {
  const rows: { key: string; value: unknown }[] = [
    {
      key: SettingKey.ModelRoles,
      value: {
        default: cfg.default_model,
        router: cfg.router_model,
        embedding: cfg.embedding_model,
        error_correction: cfg.error_correction_model,
        speech: cfg.speech_model ?? "",
        synthesizer: cfg.synthesizer_model ?? "",
      },
    },
    {
      key: SettingKey.Timeouts,
      value: {
        llm_request: cfg.timeouts?.llm_request ?? "300s",
        http_client: cfg.timeouts?.http_client ?? "300s",
        llm_activity: cfg.timeouts?.llm_activity ?? "30s",
      },
    },
    {
      key: SettingKey.Agent,
      value: {
        max_history: cfg.agent?.max_history ?? 15,
        default_temperature: cfg.agent?.default_temperature ?? 0.4,
        rag_top_k: cfg.agent?.rag?.top_k ?? 10,
      },
    },
    { key: SettingKey.TelegramAllowedUsers, value: cfg.telegram?.allowed_users ?? [] },
    { key: SettingKey.McpServers, value: searchOnly(cfg.mcp_servers) },
  ];
  for (const r of rows) {
    log.debug({ key: r.key }, "seeding setting");
    await db.insert(settings).values(r).onConflictDoNothing();
  }
  log.info({ count: rows.length }, "seeded settings");
}

async function seedModels(db: Db, cfg: RawConfig): Promise<void> {
  for (const ref of cfg.models) {
    const provider = ref.split(":")[0] ?? "openrouter";
    await db.insert(modelsTable).values({ ref, provider, enabled: true }).onConflictDoNothing();
  }
  log.info({ count: cfg.models.length }, "seeded models");
}

// Default plans — parity with Go migrations 00013–00017.
const DEFAULT_PLANS = [
  { name: "free", hourlyLimit: 15, maxTasks: 3 },
  { name: "pro", hourlyLimit: 50, maxTasks: 5 },
  { name: "admin", hourlyLimit: 100, maxTasks: 10 },
];

async function seedPlans(db: Db): Promise<void> {
  for (const p of DEFAULT_PLANS) {
    await db.insert(subscriptionPlans).values(p).onConflictDoNothing();
  }
  log.info({ count: DEFAULT_PLANS.length }, "seeded subscription plans");
}

// ── skills + prompts (from SKILL.md / *.md files) ──────────────────────────
const KNOWN_SKILL_KEYS = new Set([
  "name",
  "description",
  "allowed-tools",
  "tools",
  "model",
  "temperature",
  "reasoning",
  "routable",
]);

/** Split YAML frontmatter (between leading `---` fences) from the markdown body. */
function parseFrontmatter(raw: string): { data: Record<string, unknown>; body: string } {
  const lines = raw.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return { data: {}, body: raw.trim() };
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) return { data: {}, body: raw.trim() };
  const data = (parseYaml(lines.slice(1, end).join("\n")) ?? {}) as Record<string, unknown>;
  return { data, body: lines.slice(end + 1).join("\n").trim() };
}

async function seedSkills(db: Db): Promise<void> {
  const dir = join(SEED_DIR, "skills");
  const dirs = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
  let count = 0;
  for (const e of dirs) {
    let raw: string;
    try {
      raw = readFileSync(join(dir, e.name, "SKILL.md"), "utf8");
    } catch {
      log.warn({ dir: e.name }, "no SKILL.md, skipping");
      continue;
    }
    const { data, body } = parseFrontmatter(raw);
    const name = typeof data.name === "string" ? data.name : "";
    const description = typeof data.description === "string" ? data.description : "";
    if (!name || !description) {
      log.warn({ dir: e.name }, "skill missing name/description, skipping");
      continue;
    }

    // allowed-tools: space-delimited string (or legacy `tools` array).
    let allowedTools: string[] = [];
    if (typeof data["allowed-tools"] === "string") {
      allowedTools = data["allowed-tools"].split(/\s+/).filter(Boolean);
    } else if (Array.isArray(data.tools)) {
      allowedTools = data.tools.map(String);
    }

    // Unknown frontmatter keys (e.g. max-turns, license) go into metadata.
    const metadata: Record<string, string> = {};
    for (const [k, v] of Object.entries(data)) {
      if (!KNOWN_SKILL_KEYS.has(k)) metadata[k] = String(v);
    }

    await db
      .insert(skillsTable)
      .values({
        name,
        description,
        allowedTools,
        model: typeof data.model === "string" ? data.model : "",
        temperature: typeof data.temperature === "number" ? data.temperature : null,
        reasoning: typeof data.reasoning === "boolean" ? data.reasoning : null, // tri-state
        routable: typeof data.routable === "boolean" ? data.routable : true, // absent -> true
        prompt: body,
        metadata,
      })
      .onConflictDoNothing();
    count++;
    log.debug({ skill: name, tools: allowedTools.length, routable: data.routable ?? true }, "seeded skill");
  }
  log.info({ count }, "seeded skills");
}

async function seedPrompts(db: Db): Promise<void> {
  const dir = join(SEED_DIR, "prompts");
  const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
  for (const f of files) {
    const key = f.replace(/\.md$/, "").toUpperCase(); // SOUL/FORMAT/INTEGRITY/SYNTHESIZER/WELCOME/MONITORING
    const body = readFileSync(join(dir, f), "utf8").trim();
    await db.insert(promptsTable).values({ key, body }).onConflictDoNothing();
  }
  log.info({ count: files.length }, "seeded prompts");
}

/** Seed the DB on first run (no-op if already seeded). */
export async function runSeed(db: Db): Promise<void> {
  const already = await db.select({ key: settings.key }).from(settings).limit(1);
  if (already.length > 0) {
    log.info("skip seed (already seeded)");
    return;
  }
  const cfg = loadSeedConfig();
  await seedSettings(db, cfg);
  await seedModels(db, cfg);
  await seedPlans(db);
  await seedSkills(db);
  await seedPrompts(db);
  log.info("seed complete");
}

// `npm run db:seed` entry point: migrate then seed the env-configured DB.
if (import.meta.url === `file://${process.argv[1]}`) {
  const { db } = await import("./client.js");
  const { runMigrations } = await import("./migrate.js");
  await runMigrations(db);
  await runSeed(db);
  process.exit(0);
}
