import { describe, it, expect } from "vitest";
import {
  DEFAULT_MCP_TIMEOUT_MS,
  expandMcpConfig,
  isMcpToolName,
  parseMcpConfig,
  stableMcpConfigKey,
  type McpConfig,
} from "../../src/domain/mcp-config.js";

describe("parseMcpConfig", () => {
  it("accepts a minimal HTTP server", () => {
    const r = parseMcpConfig({ mcpServers: { github: { url: "https://mcp.example.com/mcp" } } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.mcpServers.github).toEqual({ url: "https://mcp.example.com/mcp" });
  });

  it("accepts the full server shape (headers, enabled, timeout, allowedHosts)", () => {
    const r = parseMcpConfig({
      mcpServers: {
        "deep-wiki": {
          type: "http",
          url: "http://localhost:8080/mcp",
          headers: { Authorization: "Bearer ${TOKEN}" },
          enabled: false,
          timeoutMs: 15_000,
          allowedHosts: ["localhost:8080"],
        },
      },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.mcpServers["deep-wiki"]).toMatchObject({ enabled: false, timeoutMs: 15_000 });
  });

  it("rejects a non-object payload", () => {
    expect(parseMcpConfig(null)).toEqual({ ok: false, error: "config must be an object with a \"mcpServers\" map" });
    expect(parseMcpConfig("{}").ok).toBe(false);
  });

  it("rejects a missing mcpServers map", () => {
    const r = parseMcpConfig({ servers: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("unknown top-level key");
    expect(parseMcpConfig({}).ok).toBe(false);
  });

  it("rejects stdio servers with an explicit message", () => {
    const r = parseMcpConfig({ mcpServers: { local: { command: "npx", args: ["-y", "server"] } } });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("stdio is not supported");
      expect(r.error).toContain("command");
    }
  });

  it("rejects `env` (stdio) even without command", () => {
    const r = parseMcpConfig({ mcpServers: { local: { url: "https://x.dev/mcp", env: { A: "1" } } } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("stdio is not supported");
  });

  it("rejects a non-http transport type", () => {
    const r = parseMcpConfig({ mcpServers: { legacy: { type: "sse", url: "https://x.dev/sse" } } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(`only "http" is supported`);
  });

  it("rejects a malformed URL without echoing it", () => {
    const r = parseMcpConfig({ mcpServers: { bad: { url: "not a url" } } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).not.toContain("not a url");
  });

  it("rejects a non-http(s) scheme", () => {
    const r = parseMcpConfig({ mcpServers: { bad: { url: "ftp://example.com/mcp" } } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("http or https");
  });

  it("rejects URL-embedded credentials without echoing them", () => {
    const r = parseMcpConfig({ mcpServers: { bad: { url: "https://user:s3cret@example.com/mcp" } } });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("must not embed credentials");
      expect(r.error).not.toContain("s3cret");
    }
  });

  it("rejects CR/LF in header values without echoing them", () => {
    const r = parseMcpConfig({
      mcpServers: { bad: { url: "https://x.dev/mcp", headers: { Authorization: "a\r\nX-Injected: 1" } } },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("CR/LF");
      expect(r.error).not.toContain("X-Injected");
    }
  });

  it("rejects an invalid header name", () => {
    const r = parseMcpConfig({
      mcpServers: { bad: { url: "https://x.dev/mcp", headers: { "Bad Header": "v" } } },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("invalid header name");
  });

  it("rejects a server name containing an underscore", () => {
    const r = parseMcpConfig({ mcpServers: { my_server: { url: "https://x.dev/mcp" } } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(`no "_"`);
  });

  it("rejects unknown keys inside a server (typo protection)", () => {
    const r = parseMcpConfig({ mcpServers: { s: { url: "https://x.dev/mcp", headres: {} } } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("headres");
  });

  it("rejects an out-of-range timeout", () => {
    const r = parseMcpConfig({ mcpServers: { s: { url: "https://x.dev/mcp", timeoutMs: 5 } } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("timeoutMs");
  });
});

describe("expandMcpConfig", () => {
  it("expands ${VAR} in url, headers and allowedHosts", () => {
    const config: McpConfig = {
      mcpServers: {
        s: {
          url: "https://${HOST}/mcp",
          headers: { Authorization: "Bearer ${TOKEN}" },
          allowedHosts: ["${HOST}"],
        },
      },
    };
    const r = expandMcpConfig(config, { HOST: "mcp.example.com", TOKEN: "tkn" });
    expect(r.error).toBeUndefined();
    expect(r.warnings).toEqual([]);
    expect(r.servers).toEqual([
      {
        name: "s",
        url: "https://mcp.example.com/mcp",
        headers: { Authorization: "Bearer tkn" },
        enabled: true,
        timeoutMs: DEFAULT_MCP_TIMEOUT_MS,
        allowedHosts: ["mcp.example.com"],
      },
    ]);
  });

  it("warns on a missing variable, substitutes an empty string and names it", () => {
    const config: McpConfig = { mcpServers: { s: { url: "https://x.dev/mcp", headers: { A: "${MISSING}" } } } };
    const r = expandMcpConfig(config, {});
    expect(r.servers[0]!.headers.A).toBe("");
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain("MISSING");
  });

  it("flags a URL that only breaks after expansion (missing host)", () => {
    const config: McpConfig = { mcpServers: { s: { url: "https://${HOST}/mcp" } } };
    const r = expandMcpConfig(config, {});
    expect(r.error).toContain(`server "s"`);
    expect(r.error).toContain("not a valid http(s) URL");
  });

  it("applies the enabled/timeout defaults", () => {
    const r = expandMcpConfig({ mcpServers: { s: { url: "https://x.dev/mcp" } } }, {});
    expect(r.servers[0]).toMatchObject({ enabled: true, timeoutMs: DEFAULT_MCP_TIMEOUT_MS });
  });

  it("returns an empty list for an empty config", () => {
    expect(expandMcpConfig({ mcpServers: {} }, {})).toEqual({ servers: [], warnings: [] });
  });
});

describe("stableMcpConfigKey", () => {
  const base = expandMcpConfig(
    {
      mcpServers: {
        b: { url: "https://b.dev/mcp", headers: { X: "1", A: "2" } },
        a: { url: "https://a.dev/mcp" },
      },
    },
    {},
  ).servers;

  it("is order-independent for servers and headers", () => {
    const reordered = expandMcpConfig(
      {
        mcpServers: {
          a: { url: "https://a.dev/mcp" },
          b: { url: "https://b.dev/mcp", headers: { A: "2", X: "1" } },
        },
      },
      {},
    ).servers;
    expect(stableMcpConfigKey(base)).toBe(stableMcpConfigKey(reordered));
  });

  it("changes when an expanded value changes", () => {
    const withEnv = expandMcpConfig({ mcpServers: { s: { url: "https://${H}/mcp" } } }, { H: "x.dev" }).servers;
    const other = expandMcpConfig({ mcpServers: { s: { url: "https://${H}/mcp" } } }, { H: "y.dev" }).servers;
    expect(stableMcpConfigKey(withEnv)).not.toBe(stableMcpConfigKey(other));
  });

  it("changes when enabled flips", () => {
    const off = expandMcpConfig({ mcpServers: { s: { url: "https://x.dev/mcp", enabled: false } } }, {}).servers;
    const on = expandMcpConfig({ mcpServers: { s: { url: "https://x.dev/mcp" } } }, {}).servers;
    expect(stableMcpConfigKey(off)).not.toBe(stableMcpConfigKey(on));
  });
});

describe("isMcpToolName", () => {
  it("accepts namespaced tool names up to 64 chars", () => {
    expect(isMcpToolName("github_create_issue")).toBe(true);
    expect(isMcpToolName("a".repeat(64))).toBe(true);
  });

  it("rejects long, empty and space/colon-containing names", () => {
    expect(isMcpToolName("a".repeat(65))).toBe(false);
    expect(isMcpToolName("")).toBe(false);
    expect(isMcpToolName("foo bar")).toBe(false);
    expect(isMcpToolName("foo:bar")).toBe(false);
  });
});
