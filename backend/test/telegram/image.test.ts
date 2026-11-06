import { describe, expect, it } from "vitest";
import {
  downloadTelegramImage,
  inferImageMime,
  pickLargestPhoto,
  UNSUPPORTED_IMAGE_REPLY,
  type PhotoSize,
} from "../../src/telegram/image.js";
import { TelegramReplyError } from "../../src/telegram/errors.js";
import type { FetchLike, TelegramFileApi } from "../../src/telegram/files.js";

function apiWith(filePath?: string): TelegramFileApi {
  return { getFile: async () => (filePath === undefined ? {} : { file_path: filePath }) };
}

function okFetch(bytes = 16): FetchLike {
  return async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(bytes) });
}

function photo(file_id: string, width: number, height: number, file_size?: number): PhotoSize {
  return { file_id, width, height, ...(file_size !== undefined ? { file_size } : {}) };
}

describe("pickLargestPhoto", () => {
  it("picks the largest variant that fits the byte cap", () => {
    const sizes = [
      photo("s", 90, 90, 1_000),
      photo("m", 320, 320, 5_000),
      photo("l", 1280, 1280, 9_000_000),
    ];
    expect(pickLargestPhoto(sizes, 10_000)?.file_id).toBe("m");
    expect(pickLargestPhoto(sizes)?.file_id).toBe("l");
  });

  it("treats missing file_size as fitting", () => {
    const sizes = [photo("a", 10, 10), photo("b", 20, 20)];
    expect(pickLargestPhoto(sizes, 1)?.file_id).toBe("b");
  });

  it("falls back to the last (largest) variant when every size exceeds the cap", () => {
    const sizes = [photo("a", 10, 10, 20 * 1024 * 1024), photo("b", 20, 20, 30 * 1024 * 1024)];
    expect(pickLargestPhoto(sizes, 10 * 1024 * 1024)?.file_id).toBe("b");
  });

  it("returns undefined for an empty list", () => {
    expect(pickLargestPhoto([])).toBeUndefined();
  });
});

describe("inferImageMime", () => {
  it("maps every supported extension", () => {
    expect(inferImageMime("photos/a.jpg")).toBe("image/jpeg");
    expect(inferImageMime("photos/a.jpeg")).toBe("image/jpeg");
    expect(inferImageMime("photos/a.PNG")).toBe("image/png");
    expect(inferImageMime("photos/a.webp")).toBe("image/webp");
  });

  it("returns undefined for unknown formats", () => {
    expect(inferImageMime("photos/a.gif")).toBeUndefined();
    expect(inferImageMime("photos/a.heic")).toBeUndefined();
    expect(inferImageMime("photos/a.avif")).toBeUndefined();
    expect(inferImageMime()).toBeUndefined();
  });

  it("prefers a supported MIME hint (document uploads)", () => {
    expect(inferImageMime("documents/file_1", "image/webp")).toBe("image/webp");
    expect(inferImageMime("documents/file_1", "image/jpeg; charset=binary")).toBe("image/jpeg");
  });
});

describe("downloadTelegramImage", () => {
  it("downloads an image and returns its bytes + media type", async () => {
    const result = await downloadTelegramImage(apiWith("photos/file_1.png"), "TOKEN", "fid", {
      fetchFn: okFetch(32),
    });
    expect(result.mediaType).toBe("image/png");
    expect(result.data.byteLength).toBe(32);
  });

  it("uses the document MIME hint when the file path has no extension", async () => {
    const result = await downloadTelegramImage(apiWith("documents/file_1"), "TOKEN", "fid", {
      fetchFn: okFetch(8),
      mimeHint: "image/webp",
    });
    expect(result.mediaType).toBe("image/webp");
  });

  it("rejects a getFile response without file_path", async () => {
    await expect(
      downloadTelegramImage(apiWith(undefined), "T", "fid", { fetchFn: okFetch() }),
    ).rejects.toBeInstanceOf(TelegramReplyError);
  });

  it("rejects a thrown getFile call", async () => {
    const api: TelegramFileApi = {
      getFile: async () => {
        throw new Error("network");
      },
    };
    await expect(downloadTelegramImage(api, "T", "fid", { fetchFn: okFetch() })).rejects.toBeInstanceOf(
      TelegramReplyError,
    );
  });

  it("rejects an HTTP error", async () => {
    const failFetch: FetchLike = async () => ({
      ok: false,
      status: 500,
      arrayBuffer: async () => new ArrayBuffer(0),
    });
    await expect(
      downloadTelegramImage(apiWith("photos/a.jpg"), "T", "fid", { fetchFn: failFetch }),
    ).rejects.toBeInstanceOf(TelegramReplyError);
  });

  it("rejects a download timeout/throw", async () => {
    const throwFetch: FetchLike = async () => {
      throw new Error("timeout");
    };
    await expect(
      downloadTelegramImage(apiWith("photos/a.jpg"), "T", "fid", { fetchFn: throwFetch }),
    ).rejects.toBeInstanceOf(TelegramReplyError);
  });

  it("rejects an image larger than maxBytes", async () => {
    await expect(
      downloadTelegramImage(apiWith("photos/a.jpg"), "T", "fid", { fetchFn: okFetch(100), maxBytes: 10 }),
    ).rejects.toBeInstanceOf(TelegramReplyError);
  });

  it("refuses unsupported image formats with a friendly reply", async () => {
    const err = await downloadTelegramImage(apiWith("photos/a.heic"), "T", "fid", {
      fetchFn: okFetch(8),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TelegramReplyError);
    expect((err as TelegramReplyError).userMessage).toBe(UNSUPPORTED_IMAGE_REPLY);
  });
});
