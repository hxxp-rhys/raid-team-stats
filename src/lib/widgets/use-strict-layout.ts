"use client";

import { useCallback, useSyncExternalStore } from "react";

const STORAGE_KEY = "rts:dashboard:strict-layout";

const readStored = (): boolean => {
  if (typeof window === "undefined") return true;
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    // Default ON: a missing key means "the user hasn't opted out".
    if (v === null) return true;
    return v === "true";
  } catch {
    return true;
  }
};

// Same-tab subscribers — the native `storage` event only fires in OTHER tabs,
// so a write in this tab notifies this Set directly.
const listeners = new Set<() => void>();

const subscribe = (cb: () => void): (() => void) => {
  listeners.add(cb);
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) cb();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(cb);
    window.removeEventListener("storage", onStorage);
  };
};

const getSnapshot = (): boolean => readStored();
const getServerSnapshot = (): boolean => true;

/**
 * Per-user, per-browser "strict layout" preference. When ON, drag/resize/
 * stepper changes that would cause widgets to overlap are silently dropped.
 * When OFF, original behaviour (overlap allowed, CSS grid auto-flow handles
 * the visual stack).
 *
 * Persisted in localStorage so the toggle applies across every dashboard the
 * user opens in the same browser. Not synced cross-device — that would
 * require a User column + tRPC; we can promote later if needed.
 *
 * Backed by `useSyncExternalStore`: `getServerSnapshot` (= true, the default)
 * is used during SSR + hydration, then the localStorage value afterward —
 * hydration-safe with no setState-in-effect (which the React lint rule
 * `no-set-state-in-effects` flags as a cascading-render risk).
 */
export function useStrictLayout(): {
  strict: boolean;
  setStrict: (next: boolean) => void;
  toggle: () => void;
} {
  const strict = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot,
  );

  const setStrict = useCallback((next: boolean) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, next ? "true" : "false");
    } catch {
      // localStorage write can fail in private mode / quota; ignore.
    }
    for (const l of listeners) l();
  }, []);

  const toggle = useCallback(() => setStrict(!readStored()), [setStrict]);

  return { strict, setStrict, toggle };
}
