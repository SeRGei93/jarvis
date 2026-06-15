import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Skill } from "../../src/domain/entities.js";
import { SkillRepository, serializeSkill } from "../../src/content/skill-repository.js";
import { PromptRepository } from "../../src/content/prompt-repository.js";
import { SkillService } from "../../src/services/skill-service.js";

/** A temp content dir plus a cleanup that removes it. */
export interface TempDir {
  dir: string;
  cleanup: () => void;
}

/** A partial skill (name required); the rest is filled by Skill defaults. */
export type SkillInput = Partial<Skill> & { name: string };

/**
 * Write each skill as `<name>/SKILL.md` (via serializeSkill) into a fresh
 * `mkdtemp` directory. Returns the dir + a cleanup. Use as a `SKILLS_DIR` for
 * `SkillRepository`, replacing the old `db.insert(skills)` fixtures.
 */
export function tempSkillsDir(skills: SkillInput[] = []): TempDir {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-skills-"));
  for (const input of skills) {
    const skill = Skill.parse(input);
    mkdirSync(join(dir, skill.name), { recursive: true });
    writeFileSync(join(dir, skill.name, "SKILL.md"), serializeSkill(skill), "utf8");
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Write each prompt as `<KEY>.md` into a fresh `mkdtemp` directory. Returns the
 * dir + a cleanup. Use as a `PROMPTS_DIR` for `PromptRepository`.
 */
export function tempPromptsDir(prompts: Record<string, string> = {}): TempDir {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-prompts-"));
  for (const [key, body] of Object.entries(prompts)) {
    writeFileSync(join(dir, `${key}.md`), `${body.trim()}\n`, "utf8");
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A file-backed content fixture: temp skill/prompt dirs + repos + a SkillService. */
export interface ContentFixture {
  skillsDir: string;
  promptsDir: string;
  skillRepo: SkillRepository;
  promptRepo: PromptRepository;
  skills: SkillService;
  cleanup: () => void;
}

/**
 * One-stop file-backed content fixture: writes the given skills/prompts to temp
 * dirs and wires `SkillRepository`, `PromptRepository`, and a `SkillService` over
 * them. Call `cleanup()` (e.g. in afterEach) to remove both temp dirs.
 */
export function tempContent(opts: { skills?: SkillInput[]; prompts?: Record<string, string> } = {}): ContentFixture {
  const s = tempSkillsDir(opts.skills ?? []);
  const p = tempPromptsDir(opts.prompts ?? {});
  const skillRepo = new SkillRepository(s.dir);
  const promptRepo = new PromptRepository(p.dir);
  return {
    skillsDir: s.dir,
    promptsDir: p.dir,
    skillRepo,
    promptRepo,
    skills: new SkillService(skillRepo, promptRepo),
    cleanup: () => {
      s.cleanup();
      p.cleanup();
    },
  };
}
