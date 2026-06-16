import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reconcileDefaults, atomicWrite, parseFrontmatter } from "../../src/content/store.js";

const tmps: string[] = [];
function mkTmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmps.push(d);
  return d;
}
afterEach(() => {
  while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true });
});

describe("reconcileDefaults", () => {
  it("populates an empty/absent store dir (recursively) and writes a manifest", async () => {
    const defaults = mkTmp("defaults-");
    mkdirSync(join(defaults, "a", "references"), { recursive: true });
    writeFileSync(join(defaults, "a", "SKILL.md"), "alpha");
    writeFileSync(join(defaults, "a", "references", "guide.md"), "guide");
    writeFileSync(join(defaults, "b.md"), "beta");

    const store = join(mkTmp("store-parent-"), "store"); // does not exist yet
    const res = await reconcileDefaults(store, defaults);

    expect(res).toEqual({ written: 3, skipped: 0, upToDate: false });
    expect(readFileSync(join(store, "a", "SKILL.md"), "utf8")).toBe("alpha");
    expect(readFileSync(join(store, "a", "references", "guide.md"), "utf8")).toBe("guide");
    expect(readFileSync(join(store, "b.md"), "utf8")).toBe("beta");
    expect(existsSync(join(store, ".content-manifest.json"))).toBe(true);
  });

  it("is a no-op (upToDate) on a second run when defaults are unchanged", async () => {
    const defaults = mkTmp("defaults-");
    writeFileSync(join(defaults, "x.md"), "v1");
    const store = mkTmp("store-");

    await reconcileDefaults(store, defaults);
    const again = await reconcileDefaults(store, defaults);
    expect(again).toEqual({ written: 0, skipped: 0, upToDate: true });
  });

  it("delivers a changed default to a file the admin never edited", async () => {
    const defaults = mkTmp("defaults-");
    const store = mkTmp("store-");
    writeFileSync(join(defaults, "x.md"), "v1");
    await reconcileDefaults(store, defaults); // store x.md = v1

    writeFileSync(join(defaults, "x.md"), "v2"); // ship a new default
    const res = await reconcileDefaults(store, defaults);

    expect(res).toMatchObject({ written: 1, skipped: 0 });
    expect(readFileSync(join(store, "x.md"), "utf8")).toBe("v2");
  });

  it("preserves an admin-edited file when the default changes", async () => {
    const defaults = mkTmp("defaults-");
    const store = mkTmp("store-");
    writeFileSync(join(defaults, "x.md"), "v1");
    await reconcileDefaults(store, defaults); // store x.md = v1 (recorded baseline)

    writeFileSync(join(store, "x.md"), "user-edited"); // admin edit
    writeFileSync(join(defaults, "x.md"), "v2"); // new default ships
    const res = await reconcileDefaults(store, defaults);

    expect(res).toMatchObject({ written: 0, skipped: 1 });
    expect(readFileSync(join(store, "x.md"), "utf8")).toBe("user-edited");
  });

  it("returns a no-op (no throw) when the defaults dir is missing", async () => {
    const store = mkTmp("store-");
    const res = await reconcileDefaults(store, join(store, "does-not-exist"));
    expect(res).toEqual({ written: 0, skipped: 0, upToDate: true });
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
