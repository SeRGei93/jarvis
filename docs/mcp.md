[← Tools](tools.md) · [Back to README](../README.md) · [Web Search →](web-search.md)

# MCP servers (admin-managed, HTTP only)

`jarvis` can connect to remote [Model Context Protocol](https://modelcontextprotocol.io) servers and expose their **tools** to the orchestrator. Servers are configured from the admin Mini App as a JSON document — no redeploy, no file editing.

> **Scope (v1):** HTTP (Streamable HTTP) servers only. **stdio** servers (`command`/`args`/`env`) are rejected: the project has a hard "no `exec` / no model-driven code execution" stance. Resources, prompts, events, OAuth and `requireToolApproval` are out of scope too.

## Configuration

The MCP section of the Mini App edits the `mcp_servers` **setting** (a libSQL row). The shape mirrors Claude Desktop:

```json
{
  "mcpServers": {
    "github": {
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer ${GITHUB_MCP_TOKEN}" },
      "enabled": true,
      "timeoutMs": 60000,
      "allowedHosts": ["mcp.example.com"]
    }
  }
}
```

| Field | Required | Default | Meaning |
|-------|----------|---------|---------|
| `url` | yes | — | MCP endpoint. Must be `http`/`https`, must not embed credentials (`user:pass@`) — use `headers` |
| `headers` | no | `{}` | Static request headers sent on every call |
| `enabled` | no | `true` | `false` keeps the entry stored but never connects |
| `timeoutMs` | no | `60000` | Per-tool-call timeout |
| `allowedHosts` | no | unset | SDK-level host allowlist (defense in depth); exact `host[:port]`, no wildcards |
| `type` | no | `"http"` | Only `"http"` is accepted (`"sse"` → validation error) |

Server **names** are `[A-Za-z0-9][A-Za-z0-9-]{0,39}` — **no underscores**. Tool names are namespaced `<server>_<tool>` (the SDK convention), so an underscore in the server name would make the namespace ambiguous.

Validation is strict: unknown keys are errors (typo protection), header names must be valid RFC 7230 tokens, and header values may not contain CR/LF (header injection). Error messages never echo header values or URLs — both may carry secrets.

### `${VAR}` env substitution

`url`, every header value and every `allowedHosts` entry support `${VAR}` placeholders resolved from the **backend process env**:

```json
{ "url": "https://mcp.example.com/mcp", "headers": { "Authorization": "Bearer ${GITHUB_MCP_TOKEN}" } }
```

The database stores the **raw** config with the placeholder, so secrets stay in `.env` (Docker env / secret store). A missing variable logs a WARN naming only the variable and substitutes an empty string — the admin UI shows it in the `warnings` block, and a URL that becomes malformed is reported per server instead of breaking the whole config.

## How tools reach the model

1. The admin saves the config → `settings.invalidate()` → `McpManager.refresh({ force: true })`.
2. `McpManager` expands `${VAR}`, builds the SDK server definitions (`connectTimeout` 10 s, server logs off, `forwardInstructions: false`) and performs **one** `listToolsetsWithErrors({ perServerTimeoutMs: 10_000 })` call — toolsets come back grouped per server, so no second discovery pass is needed.
3. Tools are flattened as `<server>_<tool>` into a snapshot; names that do not match `^[A-Za-z0-9_-]{1,64}$` (or whose namespaced form exceeds 64 chars) are skipped with a WARN.
4. The orchestrator takes the snapshot **once per turn**, registers the tools next to the built-ins and keeps them **always active** — they are not gated by a skill's `allowed-tools`. The model can call them on any step.

Collision rules:

- A built-in tool name always wins; the colliding MCP tool is skipped with a WARN.
- An MCP tool named `load_skill` is dropped — it can never shadow progressive skill loading.

> MCP tool output is **untrusted model input**. `forwardInstructions` is off (a server cannot inject text into the system prompt); tools from untrusted servers can still return adversarial content, so only connect servers you trust. No output sanitizer is applied in v1.

## Lifecycle and status

| Where | What happens |
|-------|--------------|
| Boot | `createChatService` creates the manager and starts `refresh({ force: true })` **in the background** — an unreachable server never blocks startup |
| Admin save (`PUT /admin/api/mcp`) | Store → `invalidate()` → awaited force-refresh, so the response carries the new status |
| «Обновить статус» (`POST .../refresh`) | Force re-discovery of the **saved** config (e.g. after the remote server redeployed) |
| «Проверить» (`POST .../test`) | Ephemeral client against the **candidate** config; nothing is stored and the live snapshot is untouched |
| Shutdown | `server.ts` awaits `ChatService.close()` → `McpManager.close()` **before** closing libSQL |

Details:

- The SDK `MCPClient` caches instances by `id` and **synchronously disconnects** a cached instance when its config changes. To keep in-flight tool calls alive, every config generation gets a fresh id (`jarvis-admin-mcp-<n>`); the old client is retired by the manager after a short unref'd grace period (5 s) and then disconnected. An unchanged config reuses the client (a forced refresh just re-discovers on it).
- Refreshes are serialized. A request that arrives while a pass is running is coalesced into **one** follow-up pass (latest-wins), so a save is never dropped.
- Per-server status: `{ name, enabled, connected, toolCount, tools, error?, durationMs? }`. One failing server does not affect the others. If discovery fails completely, the tool snapshot is emptied — stale tools pointing at a disconnected client are never served.
- `ready: false` means the first background pass has not finished yet (the UI shows an info alert). `refreshing: true` while a pass is running.

## Admin API

All routes sit behind the standard admin auth (`initData` HMAC + `ADMIN_USER_IDS`).

| Route | Body | Response |
|-------|------|----------|
| `GET /admin/api/mcp` | — | `{ config, ready, refreshing, status }` |
| `PUT /admin/api/mcp` | the full `{ "mcpServers": { … } }` | `{ ok, config, ready, refreshing, status, warnings }` |
| `POST /admin/api/mcp/test` | a candidate config | `{ ok, status, warnings }` |
| `POST /admin/api/mcp/refresh` | — | `{ ok, ready, refreshing, status }` |

`400` is returned **only** for schema problems (`{ error: string }`); connection failures are per-server entries inside a `200` response. `GET` returns the stored config as-is — including any literal header values — because it is admin-only; prefer `${VAR}` so the DB never holds a raw secret.

## Security notes

- **Trust boundary:** only an admin can add a server, and the URL may point at an internal host. That is intentional (the admin already controls the deployment), but it means the MCP endpoint list is as sensitive as the admin allowlist.
- **Headers are plaintext in the DB.** Use `${VAR}` placeholders. Headers and config values are never logged (only server names + error text).
- **No stdio, no OAuth (v1).** `command`/`args`/`env` are rejected with an explicit error; a server that answers `401` shows up as a failed connection.
- **Error text** is truncated to 500 chars and never contains headers or URLs.
- MCP tools are **not** available to the admin skill test-run (`resolveTools`, AI SDK path) — they live in the Mastra orchestrator only.

## Troubleshooting

| Symptom | Likely cause |
|---------|--------------|
| `server "x": stdio is not supported` | the entry uses `command`/`args`/`env` — replace it with an HTTP `url` |
| `server "x": invalid server name` | the name contains `_` or an unsupported character |
| `server "x": url must not embed credentials` | move `user:pass` into `headers` |
| Status shows `invalid server url` | `${VAR}` expanded to empty (missing env var) — check the `warnings` block and `.env` |
| Status shows `discovery failed` / a connection error | the remote server is down, the URL is wrong, or the host is not in `allowedHosts` |
| Tools missing after a save | names failed the `^[A-Za-z0-9_-]{1,64}$` / 64-char check — see the WARN in the logs |
| `ready: false` for a long time | the first background pass is still running (10 s per-server discovery cap) |

## See Also

- [Admin Mini App](admin.md) — the MCP screen and the rest of the admin surface
- [Tools](tools.md) — how the orchestrator gates tools and merges MCP into the registry
- [Chat Pipeline](chat-pipeline.md) — where the per-turn tool snapshot is taken
- [Configuration](configuration.md) — the `mcp_servers` setting and `.env` secrets
