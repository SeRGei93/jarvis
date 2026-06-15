import { fileURLToPath } from "node:url";
import { env } from "../config/env.js";

/**
 * Filesystem locations for the file-backed skill/prompt content store.
 *
 * Two layers:
 *   - DEFAULTS_* — repo-bundled defaults, versioned in git and code-reviewed.
 *     Source of the first-run populate (see content/store.ts ensurePopulated()).
 *   - the *store* dirs (from env) — the runtime read+write source of truth, kept
 *     on a persistent volume in prod so admin edits survive redeploys.
 *
 * Defaults point at `backend/{skills,prompts}` (the moved-out seed dirs, task #10).
 */

/** Repo-bundled skill defaults: `backend/skills/<skill>/SKILL.md`. */
export const DEFAULTS_SKILLS_DIR = fileURLToPath(new URL("../../skills", import.meta.url));

/** Repo-bundled prompt defaults: `backend/prompts/*.md`. */
export const DEFAULTS_PROMPTS_DIR = fileURLToPath(new URL("../../prompts", import.meta.url));

/** Runtime skills store dir (`SKILLS_DIR`, persistent volume in prod). */
export function skillsStoreDir(): string {
  return env.SKILLS_DIR;
}

/** Runtime prompts store dir (`PROMPTS_DIR`, persistent volume in prod). */
export function promptsStoreDir(): string {
  return env.PROMPTS_DIR;
}
