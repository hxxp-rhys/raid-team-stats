"use client";

import { useCallback, useSyncExternalStore } from "react";

const STORAGE_KEY = "rts:dashboard:refresh-interval";

/**
 * Selectable auto-refresh periods for a dashboard. `false` = off (the React
 * Query `refetchInterval` value that disables polling). Kept as a flat list
 * so the control-panel dropdown and the hook share one source of truth.
 */
export const REFRESH_OPTIONS: ReadonlyArray<{
  label: string;
  value: number | false;
}> = [
  { label: "Off", value: false },
  { label: "30s", value: 30_000 },
  { label: "1m", value: 60_000 },
  { label: "5m", value: 300_000 },
  { label: "15m", value: 900_000 },
];

const VALID_MS = new Set(
  REFRESH_OPTIONS.map((o) => o.value).filter((v): v is number => v !== false),
);

const readStored = (): number | false => {
  if (typeof window === "undefined") return false;
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    if (v === null || v === "off") return false;
    const n = Number(v);
    // Only honour values we actually offer — guards against a stale/poisoned
    // localStorage entry pinning some arbitrary (possibly tiny) interval that
    // would hammer the WCL/Blizzard budget.
    return VALID_MS.has(n) ? n : false;
  } catch {
    return false;
  }
};

// Same-tab subscribers. The native `storage` event only fires in OTHER tabs,
// so a write in this tab notifies this Set directly; cross-tab writes arrive
// via the `storage` listener registered per-subscriber below.
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

// Returns a primitive (number | false) so React's Object.is comparison is
// referentially stable between renders when nothing changed.
const getSnapshot = (): number | false => readStored();
const getServerSnapshot = (): number | false => false;

/**
 * Per-user, per-browser dashboard auto-refresh interval. Drives a single
 * polling observer in the control panel (which shares the
 * `snapshot.latestForTeam` query key with every widget, so one poll updates
 * them all). Persisted in localStorage so the choice carries across every
 * dashboard the user opens in this browser.
 *
 * Defaults to OFF: polling spends WCL/Blizzard budget, so it must be an
 * explicit opt-in. Backed by `useSyncExternalStore`, which reads
 * `getServerSnapshot` (= false) during SSR + hydration and switches to the
 * localStorage value afterward — hydration-safe with no setState-in-effect.
 */
export function useRefreshInterval(): {
  intervalMs: number | false;
  setIntervalMs: (next: number | false) => void;
} {
  const intervalMs = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot,
  );

  const setIntervalMs = useCallback((next: number | false) => {
    try {
      window.localStorage.setItem(
        STORAGE_KEY,
        next === false ? "off" : String(next),
      );
    } catch {
      // private mode / quota — ignore.
    }
    // Notify same-tab subscribers (the storage event won't fire here).
    for (const l of listeners) l();
  }, []);

  return { intervalMs, setIntervalMs };
}
