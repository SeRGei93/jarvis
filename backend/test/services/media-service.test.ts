import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_IMAGE_BYTES,
  MediaService,
  type ImageInput,
} from "../../src/services/media-service.js";
import type { Message } from "../../src/domain/entities.js";

const DAY_MS = 24 * 60 * 60 * 1000;

let dirs: string[] = [];

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-media-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});

function bytes(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "utf8"));
}

function img(seed: string, mediaType = "image/jpeg"): ImageInput {
  return { data: bytes(`image-${seed}`), mediaType };
}

function pathOf(dir: string, id: string): string {
  return join(dir, id.slice(0, 2), id);
}

async function countFiles(dir: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) total += await countFiles(join(dir, entry.name));
    else total += 1;
  }
  return total;
}

describe("MediaService", () => {
  it("round-trips save → load with metadata", async () => {
    const dir = await makeDir();
    const svc = new MediaService({ dir });

    const ref = await svc.save({ ...img("a"), width: 640, height: 480 });
    expect(ref.mediaType).toBe("image/jpeg");
    expect(ref.id).toMatch(/^[a-f0-9]{64}\.jpg$/);
    expect(ref.width).toBe(640);
    expect(ref.height).toBe(480);
    expect((await stat(pathOf(dir, ref.id))).size).toBe(bytes("image-a").byteLength);

    const loaded = await svc.load(ref);
    expect(loaded).not.toBeNull();
    expect(loaded!.mediaType).toBe("image/jpeg");
    expect(Buffer.from(loaded!.data).toString("utf8")).toBe("image-a");
  });

  it("deduplicates identical bytes to a single file", async () => {
    const dir = await makeDir();
    const svc = new MediaService({ dir });

    const first = await svc.save(img("same"));
    const second = await svc.save(img("same"));

    expect(second.id).toBe(first.id);
    expect(await countFiles(dir)).toBe(1);
  });

  it("refreshes mtime on a dedupe hit so a re-sent image survives prune", async () => {
    const dir = await makeDir();
    const start = Date.parse("2026-01-01T00:00:00.000Z");
    let clock = start;
    const svc = new MediaService({ dir, now: () => clock });

    const ref = await svc.save(img("old"));
    const path = pathOf(dir, ref.id);
    // Age the file well beyond the retention window.
    const old = new Date(start - 30 * DAY_MS);
    await utimes(path, old, old);

    // Re-send the same bytes: mtime must be refreshed to "now".
    clock = start + DAY_MS;
    await svc.save(img("old"));

    expect(await svc.prune(7)).toBe(0);
    expect(await svc.load(ref)).not.toBeNull();
  });

  it("saveMany keeps going after a failing input and preserves order", async () => {
    const dir = await makeDir();
    const svc = new MediaService({ dir });

    const refs = await svc.saveMany([
      img("one", "image/jpeg"),
      img("bad", "image/heic"),
      img("two", "image/png"),
    ]);

    expect(refs.map((r) => r.mediaType)).toEqual(["image/jpeg", "image/png"]);
    expect(await countFiles(dir)).toBe(2);
  });

  it("saveMany drops inputs beyond the per-turn cap", async () => {
    const dir = await makeDir();
    const svc = new MediaService({ dir });

    const refs = await svc.saveMany([img("1"), img("2"), img("3")], 2);
    expect(refs).toHaveLength(2);
    expect(await countFiles(dir)).toBe(2);
  });

  it("rejects oversized images without writing", async () => {
    const dir = await makeDir();
    const svc = new MediaService({ dir });

    const oversized: ImageInput = { data: new Uint8Array(MAX_IMAGE_BYTES + 1), mediaType: "image/jpeg" };
    await expect(svc.save(oversized)).rejects.toThrow(/too large/);
    expect(await countFiles(dir)).toBe(0);
  });

  it("rejects unsupported mime types", async () => {
    const dir = await makeDir();
    const svc = new MediaService({ dir });

    await expect(svc.save(img("x", "image/heic"))).rejects.toThrow(/unsupported/);
    expect(await countFiles(dir)).toBe(0);
  });

  it("refuses path traversal and malformed ids on load", async () => {
    const dir = await makeDir();
    const svc = new MediaService({ dir });

    expect(await svc.load({ id: "../../etc/passwd", mediaType: "image/jpeg" })).toBeNull();
    expect(await svc.load({ id: "not-a-hash.jpg", mediaType: "image/jpeg" })).toBeNull();
    expect(await svc.load({ id: `${"a".repeat(64)}.jpg`, mediaType: "image/jpeg" })).toBeNull();
  });

  it("prunes files older than the retention window and keeps fresh ones", async () => {
    const dir = await makeDir();
    const now = Date.parse("2026-02-01T00:00:00.000Z");
    const svc = new MediaService({ dir, now: () => now });

    const oldRef = await svc.save(img("prune-old"));
    const freshRef = await svc.save(img("prune-fresh"));
    const oldDate = new Date(now - 10 * DAY_MS);
    await utimes(pathOf(dir, oldRef.id), oldDate, oldDate);

    expect(await svc.prune(7)).toBe(1);
    expect(await svc.load(oldRef)).toBeNull();
    expect(await svc.load(freshRef)).not.toBeNull();
  });

  it("prune never deletes files it does not own (wrong MEDIA_DIR guard)", async () => {
    const dir = await makeDir();
    const now = Date.parse("2026-02-01T00:00:00.000Z");
    const svc = new MediaService({ dir, now: () => now });

    const owned = await svc.save(img("owned"));
    const foreign = join(dir, "avocado.db");
    await writeFile(foreign, "not media");
    const old = new Date(now - 30 * DAY_MS);
    await utimes(foreign, old, old);
    await utimes(pathOf(dir, owned.id), old, old);

    expect(await svc.prune(7)).toBe(1);
    expect((await stat(foreign)).size).toBe("not media".length);
    expect(await svc.load(owned)).toBeNull();
  });

  it("prune on a missing dir is a no-op", async () => {
    const dir = await makeDir();
    const svc = new MediaService({ dir: join(dir, "does-not-exist") });
    await expect(svc.prune()).resolves.toBe(0);
  });

  it("hydrate re-attaches images only from the latest two user messages", async () => {
    const dir = await makeDir();
    const svc = new MediaService({ dir });

    const a = await svc.save(img("hist-a"));
    const b = await svc.save(img("hist-b"));
    const c = await svc.save(img("hist-c"));

    const messages: Message[] = [
      { role: "user", content: "first", images: [a] },
      { role: "assistant", content: "ok" },
      { role: "user", content: "second", images: [b] },
      { role: "assistant", content: "ok" },
      { role: "user", content: "third", images: [c] },
    ];

    const hydrated = await svc.hydrate(messages);
    expect(hydrated).toHaveLength(5);
    expect(hydrated[0]!.images).toBeUndefined();
    expect(hydrated[2]!.images).toHaveLength(1);
    expect(hydrated[4]!.images).toHaveLength(1);
    expect(Buffer.from(hydrated[4]!.images![0]!.data).toString("utf8")).toBe("image-hist-c");
  });

  it("hydrate caps images by count", async () => {
    const dir = await makeDir();
    const svc = new MediaService({ dir });

    const refs = await Promise.all([img("n1"), img("n2"), img("n3")].map((i) => svc.save(i)));
    const hydrated = await svc.hydrate([{ role: "user", content: "many", images: refs }], { maxImages: 2 });

    expect(hydrated[0]!.images).toHaveLength(2);
    expect(Buffer.from(hydrated[0]!.images![0]!.data).toString("utf8")).toBe("image-n1");
    expect(Buffer.from(hydrated[0]!.images![1]!.data).toString("utf8")).toBe("image-n2");
  });

  it("hydrate respects the byte budget and skips images that do not fit", async () => {
    const dir = await makeDir();
    const svc = new MediaService({ dir });

    const first = await svc.save(img("budget-1"));
    const second = await svc.save(img("budget-2"));
    const perImage = bytes("image-budget-1").byteLength;

    const hydrated = await svc.hydrate(
      [{ role: "user", content: "two", images: [first, second] }],
      { maxBytes: perImage + 1 },
    );

    expect(hydrated[0]!.images).toHaveLength(1);
    expect(Buffer.from(hydrated[0]!.images![0]!.data).toString("utf8")).toBe("image-budget-1");
  });

  it("hydrate does not attach an image larger than the whole budget", async () => {
    const dir = await makeDir();
    const svc = new MediaService({ dir });

    const ref = await svc.save(img("too-big-for-budget"));
    const hydrated = await svc.hydrate([{ role: "user", content: "big", images: [ref] }], { maxBytes: 4 });

    expect(hydrated[0]!.images).toBeUndefined();
  });

  it("hydrate ignores assistant images and missing files", async () => {
    const dir = await makeDir();
    const svc = new MediaService({ dir });

    const present = await svc.save(img("present"));
    const missing = { id: `${"b".repeat(64)}.png`, mediaType: "image/png" };
    const hydrated = await svc.hydrate([
      { role: "assistant", content: "assistant", images: [present] },
      { role: "user", content: "user", images: [missing, present] },
    ]);

    expect(hydrated[0]!.images).toBeUndefined();
    expect(hydrated[1]!.images).toHaveLength(1);
    expect(Buffer.from(hydrated[1]!.images![0]!.data).toString("utf8")).toBe("image-present");
  });
});
