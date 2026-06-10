"use client";

import { useCallback, useEffect, useState } from "react";

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
 * Hydration safety: the server-render and the first client render BOTH
 * return `true` (the default). On mount we read localStorage and update
 * state if the user had previously toggled OFF. This means a one-frame
 * mismatch is impossible (the initial render matches between server and
 * client).
 */
export function useStrictLayout(): {
  strict: boolean;
  setStrict: (next: boolean) => void;
  toggle: () => void;
} {
  const [strict, setStrictState] = useState<boolean>(true);

  // Reconcile with localStorage on mount. Splitting initialisation from
  // useState's lazy initializer keeps the server-rendered HTML deterministic.
  useEffect(() => {
    const stored = readStored();
    if (stored !== strict) setStrictState(stored);
    // Run once on mount — intentionally ignore `strict` in deps so a later
    // setStrict doesn't re-trigger the localStorage read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cross-tab sync: if the user toggles in another tab, follow along.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY) return;
      setStrictState(e.newValue === null ? true : e.newValue === "true");
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const setStrict = useCallback((next: boolean) => {
    setStrictState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next ? "true" : "false");
    } catch {
      // localStorage write can fail in private mode / quota; ignore.
    }
  }, []);

  const toggle = useCallback(() => setStrict(!strict), [setStrict, strict]);

  return { strict, setStrict, toggle };
}
