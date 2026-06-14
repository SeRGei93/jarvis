import { notifications } from "@mantine/notifications";
import { ApiError, isAccessDenied } from "../lib/api.js";

/**
 * Shared helpers for the config screens (Task 7). Prefixed `_config*` to avoid
 * colliding with the parallel Task 8 screens. Not part of the public app surface.
 */

/** Extract a human-readable message from any thrown value (ApiError → `.message`). */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "Неизвестная ошибка";
}

/**
 * Surface an error: trip the global access gate on 401/403, otherwise show a
 * red toast. `reportError` comes from `useAuthGate()`; pass it through so the
 * top-level <AccessDenied> can take over on auth failures.
 */
export function handleError(err: unknown, reportError: (e: unknown) => void): void {
  if (isAccessDenied(err)) {
    reportError(err);
    return;
  }
  notifications.show({ color: "red", message: errorMessage(err) });
}

/** Green success toast with a consistent default message. */
export function notifySaved(message = "Сохранено"): void {
  notifications.show({ color: "green", message });
}
