import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import WebApp from "@twa-dev/sdk";
import { isAccessDenied } from "../lib/api.js";
import { AccessDenied } from "./AccessDenied.js";

interface AuthState {
  /** Call from any API-consuming screen when a request fails; flips to denied on 401/403. */
  reportError: (err: unknown) => void;
}

const AuthContext = createContext<AuthState | null>(null);

/** Hook for screens to surface API errors to the top-level access gate. */
export function useAuthGate(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuthGate must be used within <AuthGate>");
  return ctx;
}

/**
 * Top-level boundary: renders <AccessDenied> when opened outside Telegram
 * (empty initData) or once any API call reports a 401/403. Otherwise renders
 * children and provides `reportError` via context so screens can trip the gate.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  // No initData → not inside Telegram → no admin access possible.
  const initialDenied = !WebApp.initData;
  const [denied, setDenied] = useState(initialDenied);

  const reportError = useCallback((err: unknown) => {
    if (isAccessDenied(err)) setDenied(true);
  }, []);

  const value = useMemo(() => ({ reportError }), [reportError]);

  if (denied) {
    return (
      <AccessDenied detail={initialDenied ? "initData отсутствует." : undefined} />
    );
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
