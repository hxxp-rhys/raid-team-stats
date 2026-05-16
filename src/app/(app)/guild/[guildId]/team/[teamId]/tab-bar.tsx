"use client";

import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";
import type { DashboardTab } from "@/lib/widgets/types";

type TabAction =
  | "set-default"
  | "rename"
  | "duplicate"
  | "close";

/**
 * Dashboard tab bar with right-click context menu and a "+" pseudo-tab on
 * the right edge for adding new tabs. The active tab is visually
 * highlighted; the defaultTabId tab gets a small ★ glyph.
 *
 * Right-click any tab → context menu with: Set as default, Rename, Duplicate,
 * Close. The Rename action enters inline-edit mode on the clicked tab.
 *
 * `editing` gates the right-click menu + add button — non-staff viewers see
 * only tab labels (read-only).
 */
export function TabBar({
  tabs,
  activeTabId,
  defaultTabId,
  editing,
  onSelect,
  onAdd,
  onAction,
  onRename,
}: {
  tabs: DashboardTab[];
  activeTabId: string;
  defaultTabId: string | undefined;
  editing: boolean;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onAction: (id: string, action: TabAction) => void;
  onRename: (id: string, name: string) => void;
}) {
  const [menuFor, setMenuFor] = useState<{
    tabId: string;
    x: number;
    y: number;
  } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  useEffect(() => {
    if (!menuFor) return;
    const close = () => setMenuFor(null);
    document.addEventListener("click", close);
    document.addEventListener("contextmenu", close);
    return () => {
      document.removeEventListener("click", close);
      document.removeEventListener("contextmenu", close);
    };
  }, [menuFor]);

  return (
    <>
      <div
        role="tablist"
        aria-label="Dashboard tabs"
        className="border-border flex flex-wrap items-stretch gap-1 border-b"
      >
        {tabs.map((t) => {
          const isActive = t.id === activeTabId;
          const isDefault = t.id === defaultTabId;
          return (
            <button
              key={t.id}
              role="tab"
              aria-selected={isActive}
              onClick={() => onSelect(t.id)}
              onContextMenu={(e) => {
                if (!editing) return;
                e.preventDefault();
                setMenuFor({ tabId: t.id, x: e.clientX, y: e.clientY });
              }}
              className={cn(
                "border-b-2 px-3 py-2 text-sm transition-colors -mb-px",
                isActive
                  ? "border-primary text-foreground font-medium"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
              title={editing ? "Right-click for options" : undefined}
            >
              {editingId === t.id ? (
                <InlineRename
                  initial={t.name}
                  onCommit={(name) => {
                    if (name && name !== t.name) onRename(t.id, name);
                    setEditingId(null);
                  }}
                  onCancel={() => setEditingId(null)}
                />
              ) : (
                <span className="flex items-center gap-1">
                  {isDefault && (
                    <span
                      className="text-amber-400"
                      title="Default tab"
                      aria-label="Default tab"
                    >
                      ★
                    </span>
                  )}
                  {t.name}
                  <span className="text-muted-foreground/70 text-xs">
                    ({t.widgets.length})
                  </span>
                </span>
              )}
            </button>
          );
        })}
        {editing && (
          <button
            type="button"
            onClick={onAdd}
            title="Add tab"
            aria-label="Add tab"
            className="border-transparent text-muted-foreground hover:text-primary -mb-px border-b-2 px-3 py-2 text-base transition-colors"
          >
            +
          </button>
        )}
      </div>

      {menuFor && (
        <ContextMenu
          x={menuFor.x}
          y={menuFor.y}
          onAction={(action) => {
            if (action === "rename") setEditingId(menuFor.tabId);
            else onAction(menuFor.tabId, action);
            setMenuFor(null);
          }}
        />
      )}
    </>
  );
}

function ContextMenu({
  x,
  y,
  onAction,
}: {
  x: number;
  y: number;
  onAction: (a: TabAction) => void;
}) {
  // Stop propagation so the document-wide click handler doesn't close before
  // the action fires.
  return (
    <ul
      role="menu"
      onClick={(e) => e.stopPropagation()}
      className="border-border bg-card text-foreground fixed z-50 w-44 overflow-hidden rounded-md border text-sm shadow-lg"
      style={{ left: x, top: y }}
    >
      {(
        [
          { id: "set-default", label: "Set as default", destructive: false },
          { id: "rename", label: "Rename tab", destructive: false },
          { id: "duplicate", label: "Duplicate tab", destructive: false },
          { id: "close", label: "Close tab", destructive: true },
        ] as const
      ).map((item) => (
        <li key={item.id}>
          <button
            type="button"
            role="menuitem"
            onClick={() => onAction(item.id)}
            className={cn(
              "hover:bg-muted block w-full px-3 py-2 text-left",
              item.destructive && "text-destructive",
            )}
          >
            {item.label}
          </button>
        </li>
      ))}
    </ul>
  );
}

function InlineRename({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <input
      ref={ref}
      defaultValue={initial}
      onClick={(e) => e.stopPropagation()}
      onBlur={(e) => onCommit(e.target.value.trim())}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onCommit((e.target as HTMLInputElement).value.trim());
        } else if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
      className="bg-background border-border h-6 w-32 rounded border px-1 text-xs"
      maxLength={40}
    />
  );
}
