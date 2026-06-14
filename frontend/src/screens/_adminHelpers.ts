// Shared helpers for the Task-8 admin screens (Skills / Users / Plans / Usage).
// Prefixed with `_admin` to avoid colliding with parallel Task-7 files.
import { notifications } from "@mantine/notifications";
import { ApiError, isAccessDenied } from "../lib/api.js";

/** Extract a human-readable message from any thrown value. */
export function errMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Standard failure handling for a mutating/loading call: if the error is an
 * auth failure (401/403) trip the top-level access gate via `reportError`;
 * otherwise show a red toast. Returns the message for optional inline use.
 */
export function handleApiError(err: unknown, reportError: (e: unknown) => void): string {
  const msg = errMessage(err);
  if (isAccessDenied(err)) {
    reportError(err);
  } else {
    notifications.show({ message: msg, color: "red" });
  }
  return msg;
}

/** Convenience success toast. */
export function notifyOk(message: string): void {
  notifications.show({ message, color: "green" });
}

/** Today as 'YYYY-MM-DD' (local). */
export function todayIso(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** A date N days ago as 'YYYY-MM-DD' (local). */
export function daysAgoIso(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Format a cost number ($) with up to 4 decimals, trimming trailing zeros. */
export function fmtCost(cost: number | undefined | null): string {
  if (cost == null || Number.isNaN(cost)) return "—";
  return `$${cost.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}`;
}
