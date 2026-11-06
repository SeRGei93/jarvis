import { z } from "zod";

// ══════════════════════════════════════════════════════════════════════════
// MCP server config (admin-editable JSON stored in settings.mcp_servers).
//
// HTTP-only by design: the project's security stance forbids `exec`, so stdio
// servers (`command`/`args`/`env`) are rejected with an explicit message. The
// shape mirrors Claude Desktop's `mcpServers` map with a few Jarvis additions
// (`enabled`, `timeoutMs`, `allowedHosts`).
//
// This module is PURE (zod + string handling only): no DB, no logging, no
// network. The calling layer owns WARN logging so secrets never reach the logs.
// ══════════════════════════════════════════════════════════════════════════

/**
 * Server keys become the tool-name namespace prefix (`<server>_<tool>`), so
 * they must not contain `_` — otherwise the namespace would be ambiguous.
 */
export const MCP_SERVER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,39}$/;
/** A tool name the model/tooling layer accepts (AI SDK / provider constraint). */
export const MCP_TOOL_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** Max length of the final namespaced `<server>_<tool>` name. */
export const MCP_MAX_TOOL_NAME_LENGTH = 64;
/** Default per-tool-call timeout when the server entry omits `timeoutMs`. */
export const DEFAULT_MCP_TIMEOUT_MS = 60_000;
/** `${VAR}` placeholders resolved from `process.env` (or an injected env). */
const ENV_PLACEHOLDER_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** stdio-style keys that identify a command-spawning MCP server (rejected). */
const STDIO_KEYS = ["command", "args", "env", "inheritDefaultEnv", "stderr", "cwd"] as const;

/** One server entry as stored in the settings JSON. */
export interface McpServerConfig {
  /** Transport discriminator; only `"http"` (Streamable HTTP) is supported. */
  type?: "http";
  /** MCP endpoint URL. May contain `${VAR}` placeholders. */
  url: string;
  /** Static request headers (e.g. Authorization). Values may contain `${VAR}`. */
  headers?: Record<string, string>;
  /** Defaults to `true`; `false` keeps the entry stored but unconnected. */
  enabled?: boolean;
  /** Per-tool-call timeout in ms (default {@link DEFAULT_MCP_TIMEOUT_MS}). */
  timeoutMs?: number;
  /** Optional SDK-level host allowlist (defense in depth). */
  allowedHosts?: string[];
}

/** The full `mcp_servers` setting value. */
export interface McpConfig {
  mcpServers: Record<string, McpServerConfig>;
}

/** A server entry with env placeholders expanded and defaults applied. */
export interface ResolvedMcpServer {
  /** Server key (also the tool-name prefix). */
  name: string;
  url: string;
  headers: Record<string, string>;
  enabled: boolean;
  timeoutMs: number;
  allowedHosts?: string[];
}

export type ParseMcpConfigResult =
  | { ok: true; config: McpConfig }
  | { ok: false; error: string };

export interface ExpandMcpConfigResult {
  servers: ResolvedMcpServer[];
  warnings: string[];
  /** First env-expansion problem (e.g. malformed URL after substitution). */
  error?: string;
}

/** The server schema as accepted from the admin (strict: typos are errors). */
const serverSchema = z.strictObject({
  type: z.literal("http").optional(),
  url: z.string().min(1, "url is required"),
  headers: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().optional(),
  timeoutMs: z.number().int().min(1_000).max(600_000).optional(),
  allowedHosts: z.array(z.string().min(1)).optional(),
});

/** `?`-free plain-object check (arrays/null are not objects here). */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Flatten zod issues into one line, prefixed with the offending field path. */
function formatIssues(err: z.ZodError): string {
  return err.issues
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}

/**
 * True for an absolute http(s) URL with a real host. The explicit shape check
 * matters because WHATWG URL treats `https:///mcp` as host `mcp` (an empty
 * `${HOST}` would otherwise slip through as "valid").
 */
function isHttpUrlWithHost(value: string): boolean {
  if (!/^https?:\/\/[^\s/]/i.test(value)) return false;
  try {
    const u = new URL(value);
    return (u.protocol === "http:" || u.protocol === "https:") && u.hostname.length > 0;
  } catch {
    return false;
  }
}

/**
 * True for an already-expanded http(s) URL with a real host. Raw admin input may
 * still contain `${VAR}` placeholders; `parseServer()` validates a substituted
 * copy instead (see {@link parseServer}), and `expandMcpConfig()` checks the
 * real URL after substitution.
 */
export function isHttpServerUrl(value: string): boolean {
  if (value.includes("${")) return false;
  return isHttpUrlWithHost(value);
}

/** RFC 7230 token — the only characters a header name may use. */
const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

/**
 * Validate one server entry. Messages deliberately omit configuration values
 * (no URLs with query secrets, no header values) so they are safe to return to
 * the admin UI and to log.
 */
function parseServer(value: unknown): { ok: true; config: McpServerConfig } | { ok: false; error: string } {
  if (!isPlainObject(value)) return { ok: false, error: "must be an object" };

  for (const key of STDIO_KEYS) {
    if (key in value) {
      return {
        ok: false,
        error: `stdio is not supported (found "${key}"); use an HTTP "url" instead`,
      };
    }
  }
  if ("type" in value && value.type !== "http") {
    return {
      ok: false,
      error: `unsupported type; only "http" is supported`,
    };
  }

  const parsed = serverSchema.safeParse(value);
  if (!parsed.success) return { ok: false, error: formatIssues(parsed.error) };
  const s = parsed.data;

  // URL: parseable, http(s), a real host, and without embedded credentials
  // (headers only). WHATWG URL accepts `https:///x` as host `x`, hence the
  // explicit scheme+host shape check. A raw admin URL may contain `${VAR}`
  // placeholders (expanded at refresh time), so validate a substituted copy:
  // placeholders become `1`, which keeps host/port checks meaningful while
  // still rejecting a placeholder scheme and URL-embedded credentials. The
  // post-expansion URL is validated again by `expandMcpConfig()`.
  const urlForValidation = s.url.includes("${") ? s.url.replace(ENV_PLACEHOLDER_RE, "1") : s.url;
  let u: URL;
  try {
    u = new URL(urlForValidation);
  } catch {
    return { ok: false, error: `url is not a valid URL` };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { ok: false, error: `url must use http or https` };
  }
  if (!isHttpUrlWithHost(urlForValidation)) {
    return { ok: false, error: `url must include a host` };
  }
  if (u.username || u.password) {
    return { ok: false, error: `url must not embed credentials; pass them via "headers"` };
  }

  // Headers: valid names, no CR/LF (header injection).
  for (const [name, headerValue] of Object.entries(s.headers ?? {})) {
    if (!HEADER_NAME_RE.test(name)) {
      return { ok: false, error: `invalid header name "${name}"` };
    }
    if (/[\r\n]/.test(name) || /[\r\n]/.test(headerValue)) {
      return { ok: false, error: `header "${name}" must not contain CR/LF` };
    }
  }

  return { ok: true, config: s };
}

/**
 * Parse + validate a raw admin payload. Never throws; returns a single
 * human-readable error suitable for a 400 response.
 */
export function parseMcpConfig(raw: unknown): ParseMcpConfigResult {
  if (!isPlainObject(raw)) {
    return { ok: false, error: `config must be an object with a "mcpServers" map` };
  }

  const extraTop = Object.keys(raw).filter((k) => k !== "mcpServers");
  if (extraTop.length > 0) {
    return { ok: false, error: `unknown top-level key(s): ${extraTop.join(", ")}` };
  }

  const serversRaw = raw.mcpServers;
  if (!isPlainObject(serversRaw)) {
    return { ok: false, error: `"mcpServers" must be an object` };
  }

  const config: McpConfig = { mcpServers: {} };
  for (const [name, value] of Object.entries(serversRaw)) {
    if (!MCP_SERVER_NAME_RE.test(name)) {
      return {
        ok: false,
        error: `invalid server name "${name}": expected 1-40 chars [A-Za-z0-9-], starting alphanumeric, no "_" (tool names are "<server>_<tool>")`,
      };
    }
    const parsed = parseServer(value);
    if (!parsed.ok) return { ok: false, error: `server "${name}": ${parsed.error}` };
    config.mcpServers[name] = parsed.config;
  }

  return { ok: true, config };
}

/** Expand `${VAR}` in one string; a missing variable is a warning + empty string. */
function expandValue(
  value: string,
  env: Record<string, string | undefined>,
  warnings: string[],
  server: string,
  field: string,
): string {
  return value.replace(ENV_PLACEHOLDER_RE, (_match, name: string) => {
    const resolved = env[name];
    if (resolved === undefined) {
      // Only the variable NAME is logged/echoed — never the value.
      warnings.push(`server "${server}": ${field} references missing env var "${name}"`);
      return "";
    }
    return resolved;
  });
}

/**
 * Expand `${VAR}` placeholders and apply defaults. The stored config keeps the
 * raw placeholders; secrets stay in `.env`. A server whose URL is not a valid
 * http(s) URL after expansion is kept in the list (so it can be reported in the
 * admin status) and recorded in `error`.
 */
export function expandMcpConfig(
  config: McpConfig,
  env: Record<string, string | undefined> = process.env,
): ExpandMcpConfigResult {
  const servers: ResolvedMcpServer[] = [];
  const warnings: string[] = [];
  let error: string | undefined;

  for (const [name, server] of Object.entries(config.mcpServers)) {
    const url = expandValue(server.url, env, warnings, name, "url");

    const headers: Record<string, string> = {};
    for (const [header, value] of Object.entries(server.headers ?? {})) {
      headers[header] = expandValue(value, env, warnings, name, `header "${header}"`);
    }

    const allowedHosts = server.allowedHosts?.map((host) =>
      expandValue(host, env, warnings, name, "allowedHosts"),
    );

    if (!isHttpServerUrl(url)) {
      error ??= `server "${name}": url is not a valid http(s) URL after env expansion`;
    }

    servers.push({
      name,
      url,
      headers,
      enabled: server.enabled !== false,
      timeoutMs: server.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS,
      // Preserve an explicitly configured empty array: the SDK treats it as
      // "deny every host", while omitting the field means "no restriction".
      ...(allowedHosts !== undefined ? { allowedHosts } : {}),
    });
  }

  return { servers, warnings, ...(error ? { error } : {}) };
}

/**
 * Stable comparison key over the RESOLVED servers (sorted by name and header
 * key) so a change in config — including an env value that only appears after
 * expansion — is detected as a new generation. Used for skip-if-unchanged.
 */
export function stableMcpConfigKey(servers: readonly ResolvedMcpServer[]): string {
  return JSON.stringify(
    [...servers]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((s) => ({
        name: s.name,
        url: s.url,
        headers: Object.entries(s.headers).sort(([a], [b]) => a.localeCompare(b)),
        enabled: s.enabled,
        timeoutMs: s.timeoutMs,
        allowedHosts: s.allowedHosts ?? null,
      })),
  );
}

/** True when a namespaced tool name is safe to expose to the model. */
export function isMcpToolName(name: string): boolean {
  return MCP_TOOL_NAME_RE.test(name) && name.length <= MCP_MAX_TOOL_NAME_LENGTH;
}
