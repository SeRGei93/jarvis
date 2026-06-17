import { Hono } from "hono";
import { requireAdmin, type AdminAuthDeps } from "../auth.js";
import type { AdminEnv, GetAdminDeps } from "./deps.js";
import { logger } from "../../pkg/logger.js";
import { settingsRoutes } from "./settings.js";
import { modelsRoutes } from "./models.js";
import { skillsRoutes } from "./skills.js";
import { promptsRoutes } from "./prompts.js";
import { usersRoutes } from "./users.js";
import { plansRoutes } from "./plans.js";
import { usageRoutes } from "./usage.js";
import { tasksRoutes } from "./tasks.js";

const log = logger.child({ mod: "admin-api" });

/**
 * Build the `/admin/api` sub-router: admin auth gate → readiness gate → entity
 * routers. Entity routers (Tasks 3–5) are mounted via `.route(...)` below; each
 * is a self-contained `Hono<AdminEnv>` that reads `c.var.deps` / `c.var.adminUserId`,
 * so they can be developed in parallel and wired in here without touching each other.
 */
export function buildAdminApiRouter(getDeps: GetAdminDeps, auth: AdminAuthDeps): Hono<AdminEnv> {
  const router = new Hono<AdminEnv>();

  // 1. Authn/authz: validate initData + ADMIN_USER_IDS (sets c.var.adminUserId).
  router.use("*", requireAdmin(auth));

  // 2. Readiness: the chat service boots asynchronously (best-effort). Until its
  //    deps exist, admin mutations have nothing to act on → 503.
  router.use("*", async (c, next) => {
    const deps = getDeps();
    if (!deps) {
      log.warn("admin api request before chat service ready");
      return c.json({ error: "service unavailable" }, 503);
    }
    c.set("deps", deps);
    await next();
  });

  // Liveness probe for an authenticated admin (also proves the auth wiring).
  router.get("/me", (c) => c.json({ adminUserId: c.var.adminUserId }));

  // --- entity routers (Tasks 3–5) ---
  router.route("/settings", settingsRoutes());
  router.route("/models", modelsRoutes());
  router.route("/skills", skillsRoutes());
  router.route("/prompts", promptsRoutes());
  router.route("/users", usersRoutes());
  router.route("/plans", plansRoutes());
  router.route("/usage", usageRoutes());
  router.route("/tasks", tasksRoutes());

  return router;
}
