import type { Skill, Message } from "../domain/entities.js";
import { SkillRepository } from "../content/skill-repository.js";
import { PromptRepository } from "../content/prompt-repository.js";
import type { RoutableSkill } from "../mastra/agents/router.js";
import { logger } from "../pkg/logger.js";

const log = logger.child({ mod: "skill-service" });

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
