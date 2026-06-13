"use client";

import { useSyncExternalStore } from "react";

/**
 * True on phone-sized viewports (<= 640px — Tailwind's `sm` breakpoint).
 * useSyncExternalStore keeps it SSR-safe (server snapshot = false) and
 * avoids the set-state-in-effect lint trap; subscribers re-render on
 * matchMedia changes (rotation, window resize, devtools device toolbar).
 */
const QUERY = "(max-width: 640px)";

function subscribe(onChange: () => void): () => void {
  const mql = window.matchMedia(QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

function getSnapshot(): boolean {
  return window.matchMedia(QUERY).matches;
}

function getServerSnapshot(): boolean {
  return false;
}

export function useIsMobile(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/**
 * Stack order for the mobile layout: explicit y first (the persisted
 * order), then x, with insertion order as the stable tiebreak.
 */
export function sortForMobileStack<T extends { y?: number; x?: number }>(
  widgets: readonly T[],
): T[] {
  return [...widgets].sort(
    (a, b) =>
      (a.y ?? Number.MAX_SAFE_INTEGER) - (b.y ?? Number.MAX_SAFE_INTEGER) ||
      (a.x ?? 0) - (b.x ?? 0),
  );
}
