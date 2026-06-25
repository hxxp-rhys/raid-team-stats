"use client";

import { useMemo, useState } from "react";

/**
 * Shared click-to-sort table helper for the dashboard widgets.
 *
 * Lifted verbatim (logic-wise) from the proven inline `SortHeader` + comparator
 * pattern that shipped in ilvl-roster.tsx: each column carries an accessor and a
 * `kind` ("text" | "number"); clicking a header toggles direction if it's
 * already active, otherwise switches to that column with a sensible DEFAULT
 * direction (text → ascending / A→Z, number → descending / big-first). Every
 * comparison falls back to a stable name tie-breaker so equal rows keep a fixed
 * order. Purely client-side — no data fetching, no backend coupling.
 *
 * Usage:
 *   const cols = {
 *     name: { key: "name", accessor: (r) => r.name, kind: "text" },
 *     runs: { key: "runs", accessor: (r) => r.runs, kind: "number" },
 *   } as const;
 *   const { sorted, sortKey, asc, toggle } = useSortableColumns(rows, {
 *     columns: cols,
 *     initial: { key: "runs", asc: false },
 *     tieBreaker: (r) => r.name,
 *   });
 *   ...
 *   <SortableHeader label="Runs" col="runs" active={sortKey === "runs"}
 *                   asc={asc} onSort={toggle} align="right" />
 */

export type SortKind = "text" | "number";

/** Descriptor for one sortable column. */
export type ColumnDescriptor<Row, Key extends string> = {
  /** Stable key identifying this column (matches the SortKey union). */
  key: Key;
  /** Pulls the comparable value for a row. null sorts as the lowest value. */
  accessor: (row: Row) => string | number | null;
  /** Drives the per-column default sort direction and comparison style. */
  kind: SortKind;
  /**
   * Optional override for the default direction when this column is first
   * selected. Use it when the natural reading order differs from the kind's
   * default — e.g. a numeric "rank order" where lower = higher standing wants
   * to default ascending (best-first) rather than the numeric big-first.
   */
  defaultAsc?: boolean;
};

export type ColumnMap<Row, Key extends string> = Record<
  Key,
  ColumnDescriptor<Row, Key>
>;

export type SortState<Key extends string> = {
  sortKey: Key;
  asc: boolean;
};

export type UseSortableColumnsOptions<Row, Key extends string> = {
  /** All sortable columns, keyed by their SortKey. */
  columns: ColumnMap<Row, Key>;
  /** Seed sort (preserve each widget's existing default — key + direction). */
  initial: { key: Key; asc: boolean };
  /**
   * Stable tie-breaker applied when the active column compares equal. Defaults
   * to a "name" accessor when the columns include one, else the row index order
   * is preserved (stable sort).
   */
  tieBreaker?: (row: Row) => string | number;
};

export type UseSortableColumnsResult<Row, Key extends string> = SortState<Key> & {
  /** Rows sorted by the active column + direction (original array untouched). */
  sorted: Row[];
  /** Toggle direction if `key` is active, else switch with its default dir. */
  toggle: (key: Key) => void;
};

/** Default sort direction for a freshly-selected column: text A→Z, numbers big-first. */
const defaultAscFor = (kind: SortKind): boolean => kind === "text";

function compareValues(
  a: string | number | null,
  b: string | number | null,
  kind: SortKind,
): number {
  if (kind === "number") {
    // null sorts as the lowest value (mirrors ilvl-roster's `?? -1`).
    const an = typeof a === "number" ? a : Number.NEGATIVE_INFINITY;
    const bn = typeof b === "number" ? b : Number.NEGATIVE_INFINITY;
    return an - bn;
  }
  // text
  const as = a == null ? "" : String(a);
  const bs = b == null ? "" : String(b);
  return as.localeCompare(bs);
}

/**
 * Owns `{ sortKey, asc }` state and returns the sorted rows. The comparison
 * always applies the active direction to the active column, then breaks ties
 * with the (ascending) tie-breaker so equal rows stay deterministically ordered
 * regardless of direction — exactly the ilvl-roster behaviour.
 */
export function useSortableColumns<Row, Key extends string>(
  rows: Row[],
  options: UseSortableColumnsOptions<Row, Key>,
): UseSortableColumnsResult<Row, Key> {
  const { columns, initial, tieBreaker } = options;
  const [sortKey, setSortKey] = useState<Key>(initial.key);
  const [asc, setAsc] = useState<boolean>(initial.asc);

  const sorted = useMemo(() => {
    const col = columns[sortKey];
    const dir = asc ? 1 : -1;
    const tb = tieBreaker;
    const withIdx = rows.map((row, i) => ({ row, i }));
    withIdx.sort((a, b) => {
      const primary =
        compareValues(col.accessor(a.row), col.accessor(b.row), col.kind) * dir;
      if (primary !== 0) return primary;
      if (tb) {
        const t = compareValues(tb(a.row), tb(b.row), "text");
        if (t !== 0) return t;
      }
      // Final fallback: original order (keeps the sort stable).
      return a.i - b.i;
    });
    return withIdx.map((x) => x.row);
  }, [rows, columns, sortKey, asc, tieBreaker]);

  const toggle = (key: Key) => {
    if (key === sortKey) {
      setAsc((v) => !v);
    } else {
      const c = columns[key];
      setSortKey(key);
      setAsc(c.defaultAsc ?? defaultAscFor(c.kind));
    }
  };

  return { sorted, sortKey, asc, toggle };
}

/**
 * A sortable `<th>`: renders the column label as a button with an aria-sort
 * state and a ▲/▼/↕ affordance. Styling mirrors the original inline SortHeader
 * (uppercase, muted → foreground on active/hover). Use `align="right"` for
 * numeric columns to match their right-aligned cells.
 */
export function SortableHeader<Key extends string>({
  label,
  col,
  active,
  asc,
  onSort,
  align,
  className,
  /** Header cell font weight — defaults to the dashboard's `font-medium`. */
  weight = "medium",
  /** Uppercase the label (default true). Set false to keep verbatim casing. */
  uppercase = true,
  /** Native tooltip forwarded to the header button (e.g. column legend). */
  title,
}: {
  label: string;
  col: Key;
  active: boolean;
  asc: boolean;
  onSort: (col: Key) => void;
  align?: "right" | "center";
  className?: string;
  weight?: "medium" | "normal";
  uppercase?: boolean;
  title?: string;
}) {
  const alignCls =
    align === "right" ? "text-right" : align === "center" ? "text-center" : "";
  const justifyCls =
    align === "right"
      ? "justify-end"
      : align === "center"
        ? "justify-center"
        : "";
  const weightCls = weight === "normal" ? "font-normal" : "font-medium";
  return (
    <th
      scope="col"
      aria-sort={active ? (asc ? "ascending" : "descending") : "none"}
      className={`py-1 pr-3 ${weightCls} ${alignCls} ${className ?? ""}`}
    >
      <button
        type="button"
        onClick={() => onSort(col)}
        title={title}
        className={`inline-flex w-full items-center gap-0.5 hover:text-foreground ${
          uppercase ? "uppercase" : ""
        } ${justifyCls} ${active ? "text-foreground" : ""}`}
      >
        {label}
        <span className="text-[9px]">{active ? (asc ? "▲" : "▼") : "↕"}</span>
      </button>
    </th>
  );
}
