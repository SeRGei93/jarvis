import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { SEED_DIR } from "../../db/seed.js";
import { logger } from "../../pkg/logger.js";
import type { ToolContext } from "./registry.js";

const log = logger.child({ mod: "tool-skill-ref" });

/** Tool names provided by this bucket. */
export const SKILLREF_TOOL_NAMES = new Set(["read_skill_reference"]);

/** A skill reference document available to load via `read_skill_reference`. */
export interface SkillReference {
  path: string;
  description?: string;
}

/** Max chars returned per reference (Go parity: truncate to prevent context overflow). */
const MAX_REFERENCE_CONTENT_LENGTH = 8000;

/** Subdirectories a skill may expose as references. */
const REFERENCE_SUBDIRS = ["references", "scripts", "assets"] as const;

/** Default skills filesystem root (seeded skills dir). */
function defaultSkillsRoot(): string {
  return join(SEED_DIR, "skills");
}

/**
 * Validate a reference path before resolving it (port of Go `validateReferencePath`):
 * - must be non-empty,
 * - must NOT be absolute,
 * - must NOT contain `..` (traversal),
 * - must start with one of `references/`, `scripts/`, `assets/`.
 * Returns an error message string when invalid, or `null` when the path is safe.
 */
function validateReferencePath(refPath: string): string | null {
  if (!refPath) {
    return "reference path cannot be empty";
  }
  // Prevent absolute paths (POSIX "/..." or Windows "C:\...").
  if (refPath.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(refPath) || refPath.startsWith("\\")) {
    return `reference path cannot be absolute: "${refPath}"`;
  }
  // Prevent path traversal.
  if (refPath.includes("..")) {
    return `reference path cannot contain ..: "${refPath}"`;
  }
  // Must start with an allowed subdirectory.
  const hasValidPrefix = REFERENCE_SUBDIRS.some((d) => refPath.startsWith(`${d}/`));
  if (!hasValidPrefix) {
    return `reference path must start with references/, scripts/, or assets/: "${refPath}"`;
  }
  return null;
}

/** Build the `read_skill_reference` tool. */
export function buildSkillRefTools(ctx: ToolContext): ToolSet {
  const root = ctx.skillsRoot ?? defaultSkillsRoot();

  return {
    read_skill_reference: tool({
      description:
        "Read a reference document from a skill's directory. Use this to load additional context listed in [SKILL REFERENCES].",
      inputSchema: z.object({
        skill_name: z
          .string()
          .describe("Name of the skill (e.g. 'research', 'monitoring')"),
        ref_path: z
          .string()
          .describe("Relative path within skill directory (e.g. 'references/guide.md')"),
      }),
      execute: async ({ skill_name, ref_path }) => {
        log.debug({ skill_name, ref_path }, "read_skill_reference");

        if (!skill_name) return { error: "skill_name is required" };
        if (!ref_path) return { error: "ref_path is required" };

        // Security: validate the reference path (prefix + traversal + absolute).
        const violation = validateReferencePath(ref_path);
        if (violation) {
          log.warn({ skill_name, ref_path, reason: violation }, "rejected reference path");
          return { error: violation };
        }

        const fullPath = join(root, skill_name, ref_path);

        // Must exist and be a regular file.
        if (!existsSync(fullPath)) {
          const error = `reference file not found: "${ref_path}"`;
          log.warn({ skill_name, ref_path }, "reference file not found");
          return { error };
        }
        let isFile = false;
        try {
          isFile = statSync(fullPath).isFile();
        } catch {
          isFile = false;
        }
        if (!isFile) {
          const error = `reference file not found: "${ref_path}"`;
          log.warn({ skill_name, ref_path }, "reference path is not a file");
          return { error };
        }

        let content: string;
        try {
          content = readFileSync(fullPath, "utf8");
        } catch (err) {
          const error = `failed to read reference "${ref_path}"`;
          log.warn({ skill_name, ref_path, err: String(err) }, "read reference failed");
          return { error };
        }

        // Truncate to prevent context overflow (Go parity).
        if (content.length > MAX_REFERENCE_CONTENT_LENGTH) {
          content =
            content.slice(0, MAX_REFERENCE_CONTENT_LENGTH) +
            "\n\n[Content truncated to 8000 characters]";
        }

        return { content, path: `${skill_name}/${ref_path}` };
      },
    }),
  };
}

/**
 * List reference docs for a skill by scanning its `references/`, `scripts/`,
 * and `assets/` subdirs (port of Go `ListReferences`). Each returned `path` is
 * relative to the skill dir (e.g. `references/guide.md`). Returns `[]` when the
 * skill dir has no such subdirs (or none exist). Feeds the [SKILL REFERENCES] slot.
 */
export function listReferences(skillName: string, root?: string): SkillReference[] {
  const base = root ?? defaultSkillsRoot();
  const skillDir = join(base, skillName);
  const refs: SkillReference[] = [];

  for (const subdir of REFERENCE_SUBDIRS) {
    const fullPath = join(skillDir, subdir);
    if (!existsSync(fullPath)) continue;

    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(fullPath, { withFileTypes: true });
    } catch (err) {
      log.warn({ skill: skillName, subdir, err: String(err) }, "failed to read skill subdirectory");
      continue;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) continue;
      refs.push({ path: `${subdir}/${entry.name}` });
    }
  }

  return refs;
}
