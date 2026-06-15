import { readdir, readFile, rm, stat } from "node:fs/promises";
import type { Dirent, Stats } from "node:fs";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { Skill } from "../domain/entities.js";
import { atomicWrite, parseFrontmatter } from "./store.js";
import { skillsStoreDir } from "./paths.js";
import { logger } from "../pkg/logger.js";

const log = logger.child({ mod: "skill-repository" });

/** Each skill is `<store>/<name>/SKILL.md`; references/scripts/assets sit alongside. */
const SKILL_FILE = "SKILL.md";

/** Frontmatter keys the parser understands; everything else becomes `metadata`. */
const KNOWN_SKILL_KEYS = new Set([
  "name",
  "description",
  "allowed-tools",
  "tools", // legacy array form
  "model",
  "temperature",
  "reasoning",
  "routable",
]);

/** A skill name must be a safe single path segment (also the on-disk dir name). */
const SKILL_NAME_RE = /^[a-zA-Z0-9_-]+$/;

/** True when `name` is a safe skill identifier (no traversal / separators). */
export function isValidSkillName(name: string): boolean {
  return SKILL_NAME_RE.test(name);
}

/** A stored skill plus its file mtime (exposed to the admin API as `updatedAt`). */
export interface StoredSkill {
  skill: Skill;
  updatedAt: Date;
}

/**
 * Parse a `SKILL.md` (frontmatter + body) into a domain {@link Skill}. The key is
 * the skill `name` (frontmatter, falling back to the directory name) — there is no
 * numeric id in the file store. Throws when the frontmatter YAML is malformed.
 */
export function parseSkill(raw: string, fallbackName: string): Skill {
  const { data, body } = parseFrontmatter(raw);

  const fmName = typeof data.name === "string" ? data.name.trim() : "";
  const name = fmName || fallbackName;

  // allowed-tools: space-delimited string (preferred) or legacy `tools` array.
  let allowedTools: string[] = [];
  if (typeof data["allowed-tools"] === "string") {
    allowedTools = data["allowed-tools"].split(/\s+/).filter(Boolean);
  } else if (Array.isArray(data.tools)) {
    allowedTools = data.tools.map(String);
  }

  // Unknown frontmatter keys (e.g. max-turns, license) round-trip via metadata.
  const metadata: Record<string, string> = {};
  for (const [k, v] of Object.entries(data)) {
    if (!KNOWN_SKILL_KEYS.has(k)) metadata[k] = String(v);
  }

  return Skill.parse({
    name,
    description: typeof data.description === "string" ? data.description : "",
    allowedTools,
    model: typeof data.model === "string" ? data.model : "",
    temperature: typeof data.temperature === "number" ? data.temperature : null,
    reasoning: typeof data.reasoning === "boolean" ? data.reasoning : null, // tri-state
    routable: typeof data.routable === "boolean" ? data.routable : true, // absent -> true
    prompt: body,
    metadata,
  });
}

/**
 * Serialise a {@link Skill} back to `SKILL.md` text — the inverse of
 * {@link parseSkill}. Round-trips every field: allowedTools↔space-string,
 * temperature (number), reasoning (tri-state boolean), routable, and metadata
 * (unknown frontmatter keys such as `max-turns`). `parse(serialize(s))` ≡ `s`.
 */
export function serializeSkill(skill: Skill): string {
  const fm: Record<string, unknown> = {
    name: skill.name,
    description: skill.description,
  };
  if (skill.allowedTools.length > 0) fm["allowed-tools"] = skill.allowedTools.join(" ");
  if (skill.model) fm.model = skill.model;
  if (typeof skill.temperature === "number") fm.temperature = skill.temperature;
  if (typeof skill.reasoning === "boolean") fm.reasoning = skill.reasoning;
  fm.routable = skill.routable;
  // Unknown keys last, preserving their (string) values.
  for (const [k, v] of Object.entries(skill.metadata)) fm[k] = v;

  const frontmatter = stringifyYaml(fm).trimEnd();
  return `---\n${frontmatter}\n---\n\n${skill.prompt}\n`;
}

/**
 * File-backed skill store over `SKILLS_DIR`. Reads `<name>/SKILL.md`, caches the
 * parsed skills in memory, and hot-reloads when any file's mtime changes (a
 * filesystem-agnostic check that works where `fs.watch`/inotify is unreliable,
 * e.g. some Docker volumes). Admin writes go through {@link upsert}/{@link delete}
 * (atomic + cache invalidation). A single unparseable file is skipped with a WARN
 * rather than failing the whole listing.
 */
export class SkillRepository {
  private cache: Map<string, StoredSkill> | null = null;
  private signature = "";

  constructor(private readonly dir: string = skillsStoreDir()) {}

  /** Drop the cache; the next accessor reloads from disk. */
  invalidate(): void {
    this.cache = null;
    this.signature = "";
    log.debug("skill cache invalidated");
  }

  private skillFile(name: string): string {
    return join(this.dir, name, SKILL_FILE);
  }

  /** Cheap stat-only fingerprint of `<name>/SKILL.md` mtimes — detects edits/adds/removes. */
  private async signatureOf(): Promise<string> {
    let entries: Dirent[];
    try {
      entries = await readdir(this.dir, { withFileTypes: true });
    } catch {
      return "";
    }
    const parts: string[] = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      try {
        const st = await stat(this.skillFile(e.name));
        parts.push(`${e.name}:${st.mtimeMs}`);
      } catch {
        // directory without a SKILL.md — ignore
      }
    }
    parts.sort();
    return parts.join("|");
  }

  private async load(): Promise<Map<string, StoredSkill>> {
    const sig = await this.signatureOf();
    if (this.cache && sig === this.signature) return this.cache;

    const map = new Map<string, StoredSkill>();
    let entries: Dirent[];
    try {
      entries = await readdir(this.dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.cache = map;
        this.signature = sig;
        return map;
      }
      throw err;
    }

    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const file = this.skillFile(e.name);
      let raw: string;
      let st: Stats;
      try {
        st = await stat(file);
        raw = await readFile(file, "utf8");
      } catch {
        continue; // directory without a SKILL.md
      }
      try {
        const skill = parseSkill(raw, e.name);
        map.set(skill.name, { skill, updatedAt: st.mtime });
      } catch (err) {
        log.warn({ dir: e.name, err: String(err) }, "skipping unparseable SKILL.md");
      }
    }

    this.cache = map;
    this.signature = sig;
    const routable = [...map.values()].filter((s) => s.skill.routable).length;
    log.debug({ total: map.size, routable }, "skills loaded from store");
    return map;
  }

  /** All skills (routable + cron-only). */
  async list(): Promise<Skill[]> {
    return [...(await this.load()).values()].map((s) => s.skill);
  }

  /** All skills with file mtime (admin API). */
  async listStored(): Promise<StoredSkill[]> {
    return [...(await this.load()).values()];
  }

  /** One skill by name, or null. */
  async getByName(name: string): Promise<Skill | null> {
    return (await this.load()).get(name)?.skill ?? null;
  }

  /** One skill with file mtime, or null (admin API). */
  async getStored(name: string): Promise<StoredSkill | null> {
    return (await this.load()).get(name) ?? null;
  }

  /** Create or overwrite a skill's `SKILL.md` atomically; returns it with the new mtime. */
  async upsert(skill: Skill): Promise<StoredSkill> {
    const s = Skill.parse(skill);
    if (!isValidSkillName(s.name)) throw new Error(`invalid skill name: "${s.name}"`);
    const file = this.skillFile(s.name);
    await atomicWrite(file, serializeSkill(s));
    this.invalidate();
    const st = await stat(file);
    log.info({ name: s.name }, "skill upserted to store");
    return { skill: s, updatedAt: st.mtime };
  }

  /** Delete a skill's directory (SKILL.md + references). Returns false if absent. */
  async delete(name: string): Promise<boolean> {
    if (!isValidSkillName(name)) throw new Error(`invalid skill name: "${name}"`);
    const map = await this.load();
    if (!map.has(name)) return false;
    await rm(join(this.dir, name), { recursive: true, force: true });
    this.invalidate();
    log.info({ name }, "skill deleted from store");
    return true;
  }
}
