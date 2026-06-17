import type { Skill, Message } from "../domain/entities.js";
import { SkillRepository } from "../content/skill-repository.js";
import { PromptRepository } from "../content/prompt-repository.js";
import { logger } from "../pkg/logger.js";

const log = logger.child({ mod: "skill-service" });

/**
 * A routable skill reduced to what routing needs: its name and a one-line
 * "when to apply" hint (the skill's `description` frontmatter). Used by the
 * orchestrator's skill catalog and the primary-skill pre-pass.
 */
export interface RoutableSkill {
  name: string;
  description: string;
}

/** Collapse a multi-line skill description into a single catalog line. */
function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Compact routing catalog — one line per routable skill: `- name: when-to-apply`.
 * Fed verbatim into the orchestrator system prompt and the pre-pass so the model
 * can pick which skill(s) to `load_skill`, mirroring Claude Code's skill index.
 */
export function formatSkillCatalog(skills: RoutableSkill[]): string {
  return skills.map((s) => `- ${s.name}: ${oneLine(s.description)}`).join("\n");
}

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

/**
 * Loads skills and system prompts from the file-backed content store (see
 * `src/content/`) — repo-bundled defaults populated onto a persistent volume,
 * read AND written there. Skills feed the router (routable subset), the
 * skill-agent factory, and the prompt builder (SOUL/FORMAT/INTEGRITY/SYNTHESIZER).
 *
 * Caching + hot-reload live in the repositories (mtime-based); `invalidate()`
 * forces a reload on next access (call after an admin save).
 */
export class SkillService {
  constructor(
    // Public so the admin API can drive file-backed CRUD (create/update/delete)
    // on the same instance the live chat reads — writes invalidate immediately.
    public readonly skillRepo: SkillRepository = new SkillRepository(),
    public readonly promptRepo: PromptRepository = new PromptRepository(),
  ) {}

  /** Drop both caches; the next accessor reloads from the store. */
  invalidate(): void {
    this.skillRepo.invalidate();
    this.promptRepo.invalidate();
    log.debug("caches invalidated");
  }

  /** All skills (routable + cron-only). */
  async getAllSkills(): Promise<Skill[]> {
    return this.skillRepo.list();
  }

  /** Router-facing subset: routable skills as {name, description}. */
  async getRoutableSkills(): Promise<RoutableSkill[]> {
    const all = await this.skillRepo.list();
    return all.filter((s) => s.routable).map((s) => ({ name: s.name, description: s.description }));
  }

  /**
   * Compact one-line-per-skill catalog of the routable set, for the orchestrator
   * system prompt and the primary-skill pre-pass (decision #2 — progressive skills).
   */
  async getSkillCatalog(): Promise<string> {
    return formatSkillCatalog(await this.getRoutableSkills());
  }

  /** A single skill by name, or null if unknown. */
  async getSkillByName(name: string): Promise<Skill | null> {
    const skill = await this.skillRepo.getByName(name);
    if (!skill) {
      log.warn({ name }, "skill not found");
      return null;
    }
    return skill;
  }

  /** System prompt body by key (SOUL/FORMAT/INTEGRITY/SYNTHESIZER/...), "" if absent. */
  async getPrompt(key: string): Promise<string> {
    const stored = await this.promptRepo.getStored(key);
    if (!stored) {
      log.warn({ key }, "prompt not found");
      return "";
    }
    return stored.body;
  }

  /** Convenience: load the core prompts the orchestrator/skill builder needs in one call. */
  async getCorePrompts(): Promise<{ soul: string; format: string; integrity: string }> {
    const [soul, format, integrity] = await Promise.all([
      this.getPrompt("SOUL"),
      this.getPrompt("FORMAT"),
      this.getPrompt("INTEGRITY"),
    ]);
    return { soul, format, integrity };
  }

  /** Re-exported for callers that build router input. */
  derivePreviousSkills = derivePreviousSkills;
}
