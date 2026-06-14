import type { ChatDeps } from "../../mastra/workflows/chat.js";
import type { AdminVariables } from "../auth.js";

/**
 * Services available to every admin API route handler. Reuses the chat stack's
 * dependency bundle (db, settings, skills, usage, rateLimit, …) so admin writes
 * can invalidate the very caches the live chat reads.
 */
export type AdminApiDeps = ChatDeps;

/** Lazily resolves the chat deps — undefined until the chat service finishes booting. */
export type GetAdminDeps = () => AdminApiDeps | undefined;

/**
 * Hono environment for admin API routers.
 * `adminUserId` is published by `requireAdmin`; `deps` by the readiness gate in
 * {@link ../api/index.buildAdminApiRouter}. Entity routers read both from `c.var`.
 */
export interface AdminEnv {
  Variables: AdminVariables & { deps: AdminApiDeps };
}
