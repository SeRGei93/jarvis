import { describe, it, expect } from "vitest";
import {
  isBlockedAddress,
  assertUrlAllowed,
  SsrfError,
  type LookupFn,
} from "../../../src/services/web/ssrf-guard.js";

/** A LookupFn that always returns the given addresses (no real DNS). */
function fixedLookup(addrs: Array<{ address: string; family: number }>): LookupFn {
  return async () => addrs;
}

describe("isBlockedAddress", () => {
  it("blocks private / loopback / link-local / metadata addresses", () => {
    const blocked = [
      "127.0.0.1", // loopback
      "10.0.0.5", // private 10/8
      "192.168.1.1", // private 192.168/16
      "172.16.0.1", // private 172.16/12
      "169.254.169.254", // cloud metadata / link-local
      "::1", // IPv6 loopback
      "fc00::1", // IPv6 unique-local
      "fe80::1", // IPv6 link-local
      "::ffff:127.0.0.1", // IPv4-mapped loopback
    ];
    for (const ip of blocked) {
      expect(isBlockedAddress(ip), `${ip} should be blocked`).toBe(true);
    }
  });

  it("allows public addresses", () => {
    const allowed = [
      "8.8.8.8",
      "93.184.216.34",
      "2606:2800:220:1:248:1893:25c8:1946",
    ];
    for (const ip of allowed) {
      expect(isBlockedAddress(ip), `${ip} should be allowed`).toBe(false);
    }
  });
});

describe("assertUrlAllowed", () => {
  it("rejects non-http(s) schemes", async () => {
    await expect(assertUrlAllowed("ftp://example.com")).rejects.toBeInstanceOf(SsrfError);
    await expect(assertUrlAllowed("file:///etc/passwd")).rejects.toBeInstanceOf(SsrfError);
  });

  it("rejects blocked IP-literal URLs without DNS", async () => {
    // lookupFn must never be reached for an IP literal; pass a throwing one to prove it.
    const neverCalled: LookupFn = async () => {
      throw new Error("DNS must not be called for an IP literal");
    };
    await expect(assertUrlAllowed("http://127.0.0.1/", neverCalled)).rejects.toBeInstanceOf(
      SsrfError,
    );
    await expect(
      assertUrlAllowed("http://169.254.169.254/", neverCalled),
    ).rejects.toBeInstanceOf(SsrfError);
  });

  it("rejects when DNS resolves to a private address (anti DNS-rebinding)", async () => {
    await expect(
      assertUrlAllowed("http://evil.test/", fixedLookup([{ address: "10.0.0.1", family: 4 }])),
    ).rejects.toBeInstanceOf(SsrfError);
  });

  it("resolves and returns a URL for a public address", async () => {
    const url = await assertUrlAllowed(
      "http://example.test/path",
      fixedLookup([{ address: "93.184.216.34", family: 4 }]),
    );
    expect(url).toBeInstanceOf(URL);
    expect(url.hostname).toBe("example.test");
    expect(url.pathname).toBe("/path");
  });

  it("rejects when DNS resolves to nothing", async () => {
    await expect(
      assertUrlAllowed("http://empty.test/", fixedLookup([])),
    ).rejects.toBeInstanceOf(SsrfError);
  });
});

describe("isBlockedAddress — IPv4-mapped IPv6 in hex form", () => {
  it("blocks the hex-serialised v4-mapped loopback (::ffff:7f00:1 from [::ffff:127.0.0.1])", () => {
    // new URL("http://[::ffff:127.0.0.1]/").hostname === "[::ffff:7f00:1]"
    expect(isBlockedAddress("::ffff:7f00:1")).toBe(true); // 7f00:1 == 127.0.0.1
    expect(isBlockedAddress("::ffff:a00:1")).toBe(true); // 0a00:1 == 10.0.0.1
  });
});
