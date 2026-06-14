import { eq } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import * as schema from "../db/schema.js";
import { skills, prompts } from "../db/schema.js";
import { Skill, type Message } from "../domain/entities.js";
import type { RoutableSkill } from "../mastra/agents/router.js";
import { logger } from "../pkg/logger.js";

const log = logger.child({ mod: "skill-service" });

type Db = LibSQLDatabase<typeof schema>;
type SkillRow = typeof skills.$inferSelect;

/**
 * Newest-first list of skills used in prior assistant replies (parity with Go
 * skill_service.go extractPreviousSkills). Pure — iterates history backwards and
 * collects the `skill` tag from assistant messages. No dedup (Go parity).
 */
export function derivePreviousSkills(messages: Message[]): string[] {
  const out: string[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "assistant" && m.skill) out.push(m.skill);
  }
  return out;
}

/** Map a `skills` row to the domain Skill (JSON columns are already parsed by drizzle). */
function toSkill(row: SkillRow): Skill {
  return Skill.parse({
    name: row.name,
    description: row.description,
    allowedTools: row.allowedTools,
    model: row.model,
    temperature: row.temperature,
    reasoning: row.reasoning,
    routable: row.routable,
    prompt: row.prompt,
    metadata: row.metadata,
  });
}

/**
 * Loads skills and system prompts from the DB and caches them in memory.
 * `invalidate()` forces a reload on next access (call after an admin save).
 * Skills feed the router (routable subset), the skill-agent factory, and the
 * prompt builder (SOUL/FORMAT/INTEGRITY/SYNTHESIZER bodies).
 */
export class SkillService {
  private skillCache: Map<string, Skill> | null = null;
  private promptCache: Map<string, string> | null = null;

  constructor(private readonly db: Db) {}

  /** Drop both caches; the next accessor reloads from the DB. */
  invalidate(): void {
    this.skillCache = null;
    this.promptCache = null;
    log.debug("caches invalidated");
  }

  private async loadSkills(): Promise<Map<string, Skill>> {
    if (this.skillCache) return this.skillCache;
    const rows = await this.db.select().from(skills);
    const map = new Map<string, Skill>();
    for (const r of rows) map.set(r.name, toSkill(r));
    this.skillCache = map;
    const routable = [...map.values()].filter((s) => s.routable).length;
    log.debug({ total: map.size, routable }, "skills loaded");
    return map;
  }

  /** All skills (routable + cron-only). */
  async getAllSkills(): Promise<Skill[]> {
    return [...(await this.loadSkills()).values()];
  }

  /** Router-facing subset: routable skills as {name, description}. */
  async getRoutableSkills(): Promise<RoutableSkill[]> {
    const all = await this.loadSkills();
    return [...all.values()]
      .filter((s) => s.routable)
      .map((s) => ({ name: s.name, description: s.description }));
  }

  /** A single skill by name, or null if unknown. */
  async getSkillByName(name: string): Promise<Skill | null> {
    const skill = (await this.loadSkills()).get(name);
    if (!skill) {
      log.warn({ name }, "skill not found");
      return null;
    }
    return skill;
  }

  /** System prompt body by key (SOUL/FORMAT/INTEGRITY/SYNTHESIZER/...), "" if absent. */
  async getPrompt(key: string): Promise<string> {
    if (!this.promptCache) {
      const rows = await this.db.select().from(prompts);
      this.promptCache = new Map(rows.map((r) => [r.key, r.body]));
      log.debug({ count: this.promptCache.size }, "prompts loaded");
    }
    const body = this.promptCache.get(key);
    if (body == null) {
      log.warn({ key }, "prompt not found");
      return "";
    }
    return body;
  }

  /** Convenience: load the four prompts the prompt builder needs in one call. */
  async getCorePrompts(): Promise<{ soul: string; format: string; integrity: string; synthesizer: string }> {
    const [soul, format, integrity, synthesizer] = await Promise.all([
      this.getPrompt("SOUL"),
      this.getPrompt("FORMAT"),
      this.getPrompt("INTEGRITY"),
      this.getPrompt("SYNTHESIZER"),
    ]);
    return { soul, format, integrity, synthesizer };
  }

  /** Re-exported for callers that build router input. */
  derivePreviousSkills = derivePreviousSkills;
}
