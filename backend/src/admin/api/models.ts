import { Hono } from "hono";
import { z } from "zod";
import { settings } from "../../db/schema.js";
import { SettingKey, type ModelRoles } from "../../config/settings-keys.js";
import { logger } from "../../pkg/logger.js";
import type { AdminEnv } from "./deps.js";

const log = logger.child({ mod: "admin-models" });

/** Role slots, in UI order. `decision` is optional (empty = decision layer off). */
const ROLE_KEYS = [
  "default",
  "router",
  "error_correction",
  "speech",
  "synthesizer",
  "decision",
] as const;

const rolesSchema = z.object({
  default: z.string().optional(),
  router: z.string().optional(),
  error_correction: z.string().optional(),
  speech: z.string().optional(),
  synthesizer: z.string().optional(),
  decision: z.string().optional(),
});

function zodError(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}

/** Provider = ref prefix before the first ":"; no prefix → "openrouter" (ModelFactory parity). */
function providerFromRef(ref: string): string {
  const i = ref.indexOf(":");
  return i > 0 ? ref.slice(0, i) : "openrouter";
}

/** `provider:model` with a non-empty model part. Returns an error string or null. */
function refShapeError(ref: string): string | null {
  if (/\s/.test(ref)) return `ref must not contain whitespace: "${ref}"`;
  const i = ref.indexOf(":");
  if (i === -1) return null; // bare model id → openrouter (ModelFactory parity)
  const provider = ref.slice(0, i);
  const modelId = ref.slice(i + 1);
  if (provider === "") return `missing provider before ":": "${ref}"`;
  if (modelId === "") return `missing model after ":": "${ref}"`;
  return null;
}

/**
 * Admin config router for models (mounted at /admin/api/models).
 *
 * The `models` registry is gone — a role is a free-form `provider:model` ref.
 * The UI reads OpenRouter's live catalog and filters by name on the client; this
 * router only proxies (and caches) it, plus validates role refs against it.
 */
export function modelsRoutes(): Hono<AdminEnv> {
  const r = new Hono<AdminEnv>();

  /**
   * `provider=openrouter` (default) → trimmed OpenRouter catalog for the picker;
   * `provider=decision` → curated System One list. Both `{ items, stale }`.
   */
  r.get("/catalog", async (c) => {
    const { modelsCatalog } = c.var.deps;
    const provider = c.req.query("provider") ?? "openrouter";
    if (provider === "decision") {
      log.debug({ adminUserId: c.var.adminUserId }, "decision catalog");
      return c.json(modelsCatalog.getDecisionCatalog());
    }
    if (provider !== "openrouter") {
      return c.json({ error: `unknown catalog provider: ${provider}` }, 400);
    }
    const res = await modelsCatalog.getOpenRouterCatalog();
    log.debug({ adminUserId: c.var.adminUserId, items: res.items.length, stale: res.stale }, "openrouter catalog");
    return c.json(res);
  });

  /** Legacy `GET /` → OpenRouter catalog (the registry table it used to list is gone). */
  r.get("/", async (c) => {
    const { modelsCatalog } = c.var.deps;
    return c.json(await modelsCatalog.getOpenRouterCatalog());
  });

  r.get("/roles", async (c) => {
    const { settings: svc } = c.var.deps;
    log.debug({ adminUserId: c.var.adminUserId }, "read model roles");
    return c.json(await svc.getModelRoles());
  });

  r.put("/roles", async (c) => {
    const { db, settings: svc, modelsCatalog } = c.var.deps;
    const body = await c.req.json().catch(() => undefined);
    const parsed = rolesSchema.safeParse(body);
    if (!parsed.success) {
      log.warn({ adminUserId: c.var.adminUserId }, "roles validation failed");
      return c.json({ error: zodError(parsed.error) }, 400);
    }

    // Normalise to the full ModelRoles shape (missing/empty → "").
    const roles: ModelRoles = {
      default: parsed.data.default?.trim() ?? "",
      router: parsed.data.router?.trim() ?? "",
      error_correction: parsed.data.error_correction?.trim() ?? "",
      speech: parsed.data.speech?.trim() ?? "",
      synthesizer: parsed.data.synthesizer?.trim() ?? "",
      decision: parsed.data.decision?.trim() ?? "",
    };

    const errors: string[] = [];
    const warnings: string[] = [];
    const decisionIds = new Set(modelsCatalog.getDecisionCatalog().items.map((m) => m.id));
    let catalogKnown: boolean | undefined;
    let catalogChecked = false;

    for (const key of ROLE_KEYS) {
      const ref = roles[key] ?? "";
      if (ref === "") continue;

      const shapeErr = refShapeError(ref);
      if (shapeErr) {
        errors.push(`${key}: ${shapeErr}`);
        continue;
      }

      const provider = providerFromRef(ref);
      const modelId = ref.slice(ref.indexOf(":") + 1);

      if (key === "decision") {
        // Decision models live outside the general catalog (System One endpoint).
        if (provider === "openrouter" && !decisionIds.has(modelId)) {
          errors.push(`${key}: unknown decision model ref "${modelId}" (see provider=decision catalog)`);
        }
        continue;
      }

      if (provider !== "openrouter") continue; // zai/xai/openai/google — format check only

      if (!catalogChecked) {
        catalogChecked = true;
        catalogKnown = await modelsCatalog.hasOpenRouterCatalog();
      }
      // Accept rather than lock the admin out when the catalog is unreachable;
      // an unknown-but-reachable ref only warns.
      if (catalogKnown) {
        const known = await modelsCatalog.isKnownOpenRouterRef(ref);
        if (known === false) {
          warnings.push(`${key}: "${modelId}" отсутствует в каталоге OpenRouter (принято как есть)`);
        }
      }
    }

    if (errors.length > 0) {
      log.warn({ adminUserId: c.var.adminUserId, errors }, "roles reference unknown models");
      return c.json({ error: errors.join("; "), errors }, 400);
    }
    for (const w of warnings) log.warn({ adminUserId: c.var.adminUserId, warn: w }, "role ref warning");

    const now = new Date();
    await db
      .insert(settings)
      .values({ key: SettingKey.ModelRoles, value: roles, updatedAt: now })
      .onConflictDoUpdate({ target: settings.key, set: { value: roles, updatedAt: now } });
    svc.invalidate();
    log.info({ adminUserId: c.var.adminUserId, key: SettingKey.ModelRoles }, "model roles updated");
    return c.json({ ok: true, value: roles, warnings });
  });

  return r;
}
