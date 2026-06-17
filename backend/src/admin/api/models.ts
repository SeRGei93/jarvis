import { Hono } from "hono";
import { z } from "zod";
import { eq, inArray } from "drizzle-orm";
import { settings, models as modelsTable } from "../../db/schema.js";
import { SettingKey, type ModelRoles } from "../../config/settings-keys.js";
import { logger } from "../../pkg/logger.js";
import type { AdminEnv } from "./deps.js";

const log = logger.child({ mod: "admin-models" });

// `provider` is NOT an input: it is the part of `ref` before the first colon
// (the single source of truth — same parse ModelFactory uses to resolve models).
// `label` is mandatory (a model must be human-identifiable in the UI).
const createSchema = z.object({
  ref: z.string().min(1),
  label: z.string().trim().min(1),
  enabled: z.boolean().optional(),
  supports_tools: z.boolean().optional(),
  supports_reasoning: z.boolean().optional(),
  notes: z.string().optional(),
});

const patchSchema = z
  .object({
    // No `provider` / `ref`: provider is derived from the (immutable) ref.
    label: z.string().trim().min(1).optional(),
    enabled: z.boolean().optional(),
    supports_tools: z.boolean().optional(),
    supports_reasoning: z.boolean().optional(),
    notes: z.string().optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: "no fields to update" });

/** Provider = ref prefix before the first ":"; no prefix → "openrouter" (Go parity). */
function providerFromRef(ref: string): string {
  const i = ref.indexOf(":");
  return i > 0 ? ref.slice(0, i) : "openrouter";
}

/** All five role slots; each ref is optional/empty (cleared role = ""). */
const rolesSchema = z.object({
  default: z.string().optional(),
  router: z.string().optional(),
  error_correction: z.string().optional(),
  speech: z.string().optional(),
  synthesizer: z.string().optional(),
});

function zodError(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}

/**
 * Admin config router for models CRUD + model-role assignment
 * (mounted at /admin/api/models). Every mutation invalidates the SettingsService
 * cache so the live chat re-reads the model set / roles on next access.
 */
export function modelsRoutes(): Hono<AdminEnv> {
  const r = new Hono<AdminEnv>();

  r.get("/", async (c) => {
    const { settings: svc } = c.var.deps;
    log.debug({ adminUserId: c.var.adminUserId }, "list models");
    return c.json(await svc.getModels());
  });

  r.post("/", async (c) => {
    const { db, settings: svc } = c.var.deps;
    const body = await c.req.json().catch(() => undefined);
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      log.warn({ adminUserId: c.var.adminUserId }, "model create validation failed");
      return c.json({ error: zodError(parsed.error) }, 400);
    }
    const v = parsed.data;

    // Pre-check uniqueness (ref has a UNIQUE constraint) for a clean 400.
    const dupe = await db
      .select({ id: modelsTable.id })
      .from(modelsTable)
      .where(eq(modelsTable.ref, v.ref))
      .limit(1);
    if (dupe.length > 0) {
      log.warn({ adminUserId: c.var.adminUserId, ref: v.ref }, "model ref already exists");
      return c.json({ error: `model ref already exists: ${v.ref}` }, 400);
    }

    let row;
    try {
      [row] = await db
        .insert(modelsTable)
        .values({
          ref: v.ref,
          provider: providerFromRef(v.ref),
          label: v.label,
          enabled: v.enabled ?? true,
          supportsTools: v.supports_tools ?? true,
          supportsReasoning: v.supports_reasoning ?? false,
          notes: v.notes ?? "",
          updatedAt: new Date(),
        })
        .returning();
    } catch {
      // Lost a race on the UNIQUE constraint, or some other insert failure.
      log.warn({ adminUserId: c.var.adminUserId, ref: v.ref }, "model insert failed");
      return c.json({ error: `model ref already exists: ${v.ref}` }, 400);
    }

    svc.invalidate();
    log.info({ adminUserId: c.var.adminUserId, ref: v.ref, id: row!.id }, "model created");
    return c.json({ ok: true, value: row });
  });

  r.patch("/:id", async (c) => {
    const { db, settings: svc } = c.var.deps;
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return c.json({ error: "invalid id" }, 400);

    const body = await c.req.json().catch(() => undefined);
    const parsed = patchSchema.safeParse(body);
    if (!parsed.success) {
      log.warn({ adminUserId: c.var.adminUserId, id }, "model patch validation failed");
      return c.json({ error: zodError(parsed.error) }, 400);
    }
    const v = parsed.data;

    const patch: Partial<typeof modelsTable.$inferInsert> = { updatedAt: new Date() };
    if (v.label !== undefined) patch.label = v.label;
    if (v.enabled !== undefined) patch.enabled = v.enabled;
    if (v.supports_tools !== undefined) patch.supportsTools = v.supports_tools;
    if (v.supports_reasoning !== undefined) patch.supportsReasoning = v.supports_reasoning;
    if (v.notes !== undefined) patch.notes = v.notes;

    const [row] = await db
      .update(modelsTable)
      .set(patch)
      .where(eq(modelsTable.id, id))
      .returning();
    if (!row) {
      log.warn({ adminUserId: c.var.adminUserId, id }, "model not found");
      return c.json({ error: `model ${id} not found` }, 404);
    }

    svc.invalidate();
    log.info({ adminUserId: c.var.adminUserId, id, ref: row.ref }, "model updated");
    return c.json({ ok: true, value: row });
  });

  r.delete("/:id", async (c) => {
    const { db, settings: svc } = c.var.deps;
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return c.json({ error: "invalid id" }, 400);

    const [row] = await db.delete(modelsTable).where(eq(modelsTable.id, id)).returning();
    if (!row) {
      log.warn({ adminUserId: c.var.adminUserId, id }, "model not found");
      return c.json({ error: `model ${id} not found` }, 404);
    }

    svc.invalidate();
    log.info({ adminUserId: c.var.adminUserId, id, ref: row.ref }, "model deleted");
    return c.json({ ok: true });
  });

  r.get("/roles", async (c) => {
    const { settings: svc } = c.var.deps;
    log.debug({ adminUserId: c.var.adminUserId }, "read model roles");
    return c.json(await svc.getModelRoles());
  });

  r.put("/roles", async (c) => {
    const { db, settings: svc } = c.var.deps;
    const body = await c.req.json().catch(() => undefined);
    const parsed = rolesSchema.safeParse(body);
    if (!parsed.success) {
      log.warn({ adminUserId: c.var.adminUserId }, "roles validation failed");
      return c.json({ error: zodError(parsed.error) }, 400);
    }

    // Normalise to the full ModelRoles shape (missing/empty → "").
    const roles: ModelRoles = {
      default: parsed.data.default ?? "",
      router: parsed.data.router ?? "",
      error_correction: parsed.data.error_correction ?? "",
      speech: parsed.data.speech ?? "",
      synthesizer: parsed.data.synthesizer ?? "",
    };

    // Every non-empty ref must exist in `models` AND be enabled.
    const refs = [...new Set(Object.values(roles).filter((x) => x !== ""))];
    if (refs.length > 0) {
      const rows = await db
        .select({ ref: modelsTable.ref, enabled: modelsTable.enabled })
        .from(modelsTable)
        .where(inArray(modelsTable.ref, refs));
      const enabledRefs = new Set(rows.filter((m) => m.enabled).map((m) => m.ref));
      const bad = refs.filter((ref) => !enabledRefs.has(ref));
      if (bad.length > 0) {
        log.warn({ adminUserId: c.var.adminUserId, bad }, "roles reference unknown/disabled models");
        return c.json(
          { error: `unknown or disabled model ref(s): ${bad.join(", ")}`, refs: bad },
          400,
        );
      }
    }

    const now = new Date();
    await db
      .insert(settings)
      .values({ key: SettingKey.ModelRoles, value: roles, updatedAt: now })
      .onConflictDoUpdate({ target: settings.key, set: { value: roles, updatedAt: now } });
    svc.invalidate();
    log.info({ adminUserId: c.var.adminUserId, key: SettingKey.ModelRoles }, "model roles updated");
    return c.json({ ok: true, value: roles });
  });

  return r;
}
