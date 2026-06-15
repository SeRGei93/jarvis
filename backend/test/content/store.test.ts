import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensurePopulated, atomicWrite, parseFrontmatter } from "../../src/content/store.js";

const tmps: string[] = [];
function mkTmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmps.push(d);
  return d;
}
afterEach(() => {
  while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true });
});

describe("ensurePopulated", () => {
  it("copies defaults into an empty/absent store dir (recursively)", async () => {
    const defaults = mkTmp("defaults-");
    mkdirSync(join(defaults, "a", "references"), { recursive: true });
    writeFileSync(join(defaults, "a", "SKILL.md"), "alpha");
    writeFileSync(join(defaults, "a", "references", "guide.md"), "guide");
    writeFileSync(join(defaults, "b.md"), "beta");

    const store = join(mkTmp("store-parent-"), "store"); // does not exist yet
    const copied = await ensurePopulated(store, defaults);

    expect(copied).toBe(3); // a/SKILL.md, a/references/guide.md, b.md
    expect(readFileSync(join(store, "a", "SKILL.md"), "utf8")).toBe("alpha");
    expect(readFileSync(join(store, "a", "references", "guide.md"), "utf8")).toBe("guide");
    expect(readFileSync(join(store, "b.md"), "utf8")).toBe("beta");
  });

  it("is idempotent: a non-empty store is never overwritten", async () => {
    const defaults = mkTmp("defaults-");
    writeFileSync(join(defaults, "x.md"), "from-defaults");

    const store = mkTmp("store-");
    writeFileSync(join(store, "x.md"), "user-edited");

    const copied = await ensurePopulated(store, defaults);
    expect(copied).toBe(0);
    expect(readFileSync(join(store, "x.md"), "utf8")).toBe("user-edited");
  });

  it("returns 0 (no throw) when the defaults dir is missing", async () => {
    const store = mkTmp("store-");
    const copied = await ensurePopulated(store, join(store, "does-not-exist"));
    expect(copied).toBe(0);
  });
});

describe("atomicWrite", () => {
  it("writes the file, creating parent dirs, with no leftover temp file", async () => {
    const root = mkTmp("aw-");
    const file = join(root, "nested", "deep", "SKILL.md");
    await atomicWrite(file, "hello");
    expect(readFileSync(file, "utf8")).toBe("hello");
    // No *.tmp sibling left behind.
    expect(readdirSync(join(root, "nested", "deep")).some((f) => f.endsWith(".tmp"))).toBe(false);
  });

  it("overwrites an existing file in place", async () => {
    const root = mkTmp("aw-");
    const file = join(root, "f.md");
    await atomicWrite(file, "v1");
    await atomicWrite(file, "v2");
    expect(readFileSync(file, "utf8")).toBe("v2");
    expect(existsSync(`${file}.tmp`)).toBe(false);
  });
});

describe("parseFrontmatter", () => {
  it("splits YAML frontmatter from the body", () => {
    const { data, body } = parseFrontmatter("---\nname: x\nn: 3\n---\n\nhello body\n");
    expect(data).toEqual({ name: "x", n: 3 });
    expect(body).toBe("hello body");
  });

  it("returns empty data when there is no frontmatter fence", () => {
    const { data, body } = parseFrontmatter("just a body\nno fence");
    expect(data).toEqual({});
    expect(body).toBe("just a body\nno fence");
  });
});
