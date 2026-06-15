import { logger } from "../../pkg/logger.js";

/** Base logger for the web service; create sub-loggers with `.child({ mod })`. */
export const webLogger = logger.child({ svc: "web" });

/** Convenience helper to create a module-scoped sub-logger under the web service. */
export const webChild = (mod: string) => logger.child({ svc: "web", mod });
