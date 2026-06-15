import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync, readFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { PromptRepository, isValidPromptKey } from "../../src/content/prompt-repository.js";
import { DEFAULTS_PROMPTS_DIR } from "../../src/content/paths.js";
import { tempPromptsDir, type TempDir } from "../helpers/content.js";

let tmp: TempDir | undefined;
afterEach(() => {
  tmp?.cleanup();
  tmp = undefined;
});

describe("isValidPromptKey", () => {
  it("accepts uppercase keys, rejects traversal/lowercase/empty", () => {
    expect(isValidPromptKey("SOUL")).toBe(true);
    expect(isValidPromptKey("WELCOME_2")).toBe(true);
    expect(isValidPromptKey("soul")).toBe(false);
    expect(isValidPromptKey("..")).toBe(false);
    expect(isValidPromptKey("")).toBe(false);
  });
});

describe("PromptRepository", () => {
  it("get/getStored/list over <KEY>.md files; absent key → ''", async () => {
    tmp = tempPromptsDir({ SOUL: "soul body", FORMAT: "format body" });
    const repo = new PromptRepository(tmp.dir);

    expect(await repo.get("SOUL")).toBe("soul body");
    expect(await repo.get("MISSING")).toBe("");
    expect(await repo.getStored("MISSING")).toBeNull();
    expect((await repo.list()).map((p) => p.key).sort()).toEqual(["FORMAT", "SOUL"]);
  });

  it("upsert writes <KEY>.md atomically and is visible immediately", async () => {
    tmp = tempPromptsDir({});
    const repo = new PromptRepository(tmp.dir);

    await repo.upsert("WELCOME", "hello!");
    expect(readFileSync(join(tmp.dir, "WELCOME.md"), "utf8").trim()).toBe("hello!");
    expect(await repo.get("WELCOME")).toBe("hello!");
  });

  it("rejects an unsafe key on upsert", async () => {
    tmp = tempPromptsDir({});
    const repo = new PromptRepository(tmp.dir);
    await expect(repo.upsert("../escape", "x")).rejects.toThrow();
  });

  it("hot-reloads on a content edit (mtime change)", async () => {
    tmp = tempPromptsDir({ SOUL: "v1" });
    const repo = new PromptRepository(tmp.dir);
    expect(await repo.get("SOUL")).toBe("v1");

    const file = join(tmp.dir, "SOUL.md");
    writeFileSync(file, "v2\n");
    const future = new Date(Date.now() + 10_000);
    utimesSync(file, future, future);
    expect(await repo.get("SOUL")).toBe("v2");
  });

  it("loads the repo-bundled default prompts (backend/prompts)", async () => {
    const repo = new PromptRepository(DEFAULTS_PROMPTS_DIR);
    const keys = (await repo.list()).map((p) => p.key).sort();
    expect(keys).toEqual(["FORMAT", "INTEGRITY", "MONITORING", "SOUL", "SYNTHESIZER", "WELCOME"]);
    expect((await repo.get("SOUL")).length).toBeGreaterThan(0);
  });
});
