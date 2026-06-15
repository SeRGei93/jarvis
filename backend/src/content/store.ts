import { cp, mkdir, readdir, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { Dirent } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { logger } from "../pkg/logger.js";

const log = logger.child({ mod: "content-store" });

/** True when `dir` is absent or contains no entries. */
async function isEmptyDir(dir: string): Promise<boolean> {
  try {
    const entries = await readdir(dir);
    return entries.length === 0;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw err;
  }
}

/** Count files (not directories) under `dir`, recursively. */
async function countFiles(dir: string): Promise<number> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let n = 0;
  for (const e of entries) {
    if (e.isDirectory()) n += await countFiles(join(dir, e.name));
    else n++;
  }
  return n;
}

/**
 * Populate a runtime store dir from repo-bundled defaults on first run.
 *
 * Idempotent: a no-op when `storeDir` already holds any content, so existing
 * (possibly admin-edited) files are never overwritten. Returns the number of
 * files copied (0 when already populated or when defaults are missing).
 */
export async function ensurePopulated(storeDir: string, defaultsDir: string): Promise<number> {
  if (!(await isEmptyDir(storeDir))) {
    log.debug({ storeDir }, "content store already populated, skipping");
    return 0;
  }
  if (!existsSync(defaultsDir)) {
    log.warn({ defaultsDir }, "defaults dir missing — nothing to populate");
    return 0;
  }
  const count = await countFiles(defaultsDir);
  await mkdir(storeDir, { recursive: true });
  await cp(defaultsDir, storeDir, { recursive: true });
  log.debug({ storeDir, defaultsDir, count }, "populated content store from defaults");
  return count;
}

/**
 * Write `data` to `path` atomically: write a temp sibling, then rename over the
 * target. Rename is atomic within a filesystem, so readers never observe a
 * partially-written file. Parent dirs are created as needed.
 *
 * Single-process assumption (jarvis): no cross-process locking — concurrent
 * writers across instances would need a shared lock (out of scope, see plan).
 */
export async function atomicWrite(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, data, "utf8");
  await rename(tmp, path);
}

/**
 * Split YAML frontmatter (between leading `---` fences) from the markdown body.
 * Shared by the skill/prompt repositories and the legacy DB seeder. Returns
 * `{ data: {}, body }` when there is no valid frontmatter block.
 */
export function parseFrontmatter(raw: string): { data: Record<string, unknown>; body: string } {
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
