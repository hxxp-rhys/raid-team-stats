"use client";

import { useState } from "react";

import { api } from "@/lib/trpc-client";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { wowClassColor } from "@/lib/wow";
import { cn } from "@/lib/utils";
import type { AttendanceState, RosterMember } from "@/lib/calendar/roster";
import { ReadinessBar, STATE_META, StatusControl } from "./parts";

const fmtRange = (start: string, end: string) => {
  const s = new Date(start);
  const e = new Date(end);
  const day = s.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
  const t = (d: Date) =>
    d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${day} · ${t(s)}–${t(e)}`;
};

export function EventDetailModal({
  eventId,
  open,
  onClose,
  canLead,
  onEdit,
}: {
  eventId: string | null;
  open: boolean;
  onClose: () => void;
  canLead: boolean;
  onEdit: (eventId: string) => void;
}) {
  return (
    <Modal open={open} onClose={onClose} title="Raid event">
      {open && eventId && (
        <Body eventId={eventId} canLead={canLead} onEdit={onEdit} />
      )}
    </Modal>
  );
}

function Body({
  eventId,
  canLead,
  onEdit,
}: {
  eventId: string;
  canLead: boolean;
  onEdit: (id: string) => void;
}) {
  const utils = api.useUtils();
  const q = api.calendar.eventDetail.useQuery({ eventId });
  const refetch = () => void utils.calendar.eventDetail.invalidate({ eventId });

  const lock = api.calendar.setLock.useMutation({ onSuccess: refetch });
  const cancel = api.calendar.cancelEvent.useMutation({
    onSuccess: () => {
      void utils.calendar.eventsInRange.invalidate();
      refetch();
    },
  });

  if (q.isPending) {
    return <p className="text-muted-foreground text-sm">Loading…</p>;
  }
  if (q.error || !q.data) {
    return (
      <p className="text-destructive text-sm" role="alert">
        {q.error?.message ?? "Not found"}
      </p>
    );
  }

  const { event, roster } = q.data;
  const cancelled = event.status === "CANCELLED";
  const locked = event.status === "LOCKED";

  return (
    <div className="space-y-4 text-sm">
      <header className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className={cn("text-base font-semibold", cancelled && "text-muted-foreground line-through")}>
            {event.title}
          </h3>
          <span className="border-border text-muted-foreground rounded border px-1.5 py-0.5 text-xs">
            {event.difficulty}
            {event.raidSize ? ` · ${event.raidSize}` : ""}
          </span>
          {event.seriesId && (
            <span
              className="border-border text-muted-foreground rounded border px-1.5 py-0.5 text-xs"
              title="Part of a recurring schedule"
            >
              ↻ Recurring
            </span>
          )}
          {cancelled && (
            <span className="text-destructive text-xs font-medium">CANCELLED</span>
          )}
          {locked && (
            <span className="text-amber-500 text-xs font-medium">🔒 ROSTER LOCKED</span>
          )}
        </div>
        <p className="text-muted-foreground">
          {fmtRange(event.startsAt as unknown as string, event.endsAt as unknown as string)}
        </p>
        {event.notes && (
          <p className="text-muted-foreground whitespace-pre-wrap text-xs">{event.notes}</p>
        )}
      </header>

      <ReadinessBar readiness={roster.readiness} />

      {/* Your status */}
      {!cancelled && (
        <div className="border-border rounded-md border p-3">
          <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Your status
          </p>
          {q.data.mine ? (
            <StatusControl
              eventId={eventId}
              current={(q.data.mine.state as AttendanceState) ?? null}
              currentEta={q.data.mine.etaMinutes}
              onChanged={refetch}
            />
          ) : (
            <p className="text-muted-foreground text-xs">
              You have no character on this team.
            </p>
          )}
        </div>
      )}

      {/* Leader controls */}
      {canLead && !cancelled && (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" variant="outline" onClick={() => onEdit(eventId)}>
            Edit
          </Button>
          {event.seriesId && (
            <span className="text-muted-foreground text-xs">
              edits this occurrence only — use ↻ Recurring to change the series
            </span>
          )}
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={lock.isPending}
            onClick={() => lock.mutate({ eventId, locked: !locked })}
          >
            {locked ? "Unlock roster" : "Lock roster"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={cancel.isPending}
            onClick={() => {
              if (window.confirm("Cancel this raid? Signups are kept for history.")) {
                cancel.mutate({ eventId });
              }
            }}
          >
            Cancel raid
          </Button>
        </div>
      )}

      {/* Roster by role */}
      <div className="space-y-3">
        {roster.groups.map((g) => (
          <RoleColumn
            key={g.role}
            label={
              g.role === "TANK" ? "Tanks" : g.role === "HEAL" ? "Healers" : "DPS"
            }
            members={g.members}
            eventId={eventId}
            canLead={canLead}
            locked={locked || cancelled}
            onChanged={refetch}
          />
        ))}
        {roster.unknownRole.length > 0 && (
          <RoleColumn
            label="Role unknown (needs a spec sync)"
            members={roster.unknownRole}
            eventId={eventId}
            canLead={canLead}
            locked={locked || cancelled}
            onChanged={refetch}
          />
        )}
      </div>
    </div>
  );
}

function RoleColumn({
  label,
  members,
  eventId,
  canLead,
  locked,
  onChanged,
}: {
  label: string;
  members: RosterMember[];
  eventId: string;
  canLead: boolean;
  locked: boolean;
  onChanged: () => void;
}) {
  if (members.length === 0) return null;
  const present = members.filter((m) => m.state === "CONFIRM" || m.state === "LATE").length;
  return (
    <div>
      <p className="text-muted-foreground mb-1 text-xs font-medium uppercase tracking-wide">
        {label} ({present}/{members.length})
      </p>
      <ul className="divide-border divide-y">
        {members.map((m) => (
          <RosterRow
            key={m.characterId}
            m={m}
            eventId={eventId}
            canLead={canLead}
            locked={locked}
            onChanged={onChanged}
          />
        ))}
      </ul>
    </div>
  );
}

function RosterRow({
  m,
  eventId,
  canLead,
  locked,
  onChanged,
}: {
  m: RosterMember;
  eventId: string;
  canLead: boolean;
  locked: boolean;
  onChanged: () => void;
}) {
  const utils = api.useUtils();
  const meta = STATE_META[m.state];
  const onBehalf = api.calendar.setStatusForMember.useMutation({
    onSuccess: () => {
      void utils.calendar.eventDetail.invalidate({ eventId });
      onChanged();
    },
  });
  const setSel = api.calendar.setSelection.useMutation({
    onSuccess: () => {
      void utils.calendar.eventDetail.invalidate({ eventId });
      onChanged();
    },
  });
  const [openLeader, setOpenLeader] = useState(false);

  return (
    <li className="flex flex-wrap items-center justify-between gap-2 py-1.5">
      <div className="flex items-center gap-2">
        <span aria-hidden title={meta.label}>{meta.glyph}</span>
        <span className="font-medium" style={{ color: wowClassColor(m.classId) }}>
          {m.name}
        </span>
        {m.state === "LATE" && m.etaMinutes != null && (
          <span className="text-sky-500 text-xs">+{m.etaMinutes}m</span>
        )}
        {m.reason && (
          <span className="text-muted-foreground text-xs italic" title={m.reason}>
            — {m.reason}
          </span>
        )}
        {m.selection && (
          <span
            className={cn(
              "rounded px-1 py-px text-[10px] font-medium",
              m.selection === "STARTER" && "bg-emerald-500/15 text-emerald-500",
              m.selection === "BENCH" && "bg-amber-500/15 text-amber-500",
              m.selection === "CUT" && "bg-muted text-muted-foreground",
            )}
          >
            {m.selection.toLowerCase()}
          </span>
        )}
        {m.source && m.source !== "WEBSITE" && (
          <span className="text-muted-foreground text-[10px]" title={`set via ${m.source}`}>
            ({m.source.toLowerCase()})
          </span>
        )}
      </div>
      {canLead && !locked && (
        <div className="flex items-center gap-1">
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground text-xs underline decoration-dotted"
            onClick={() => setOpenLeader((v) => !v)}
          >
            edit
          </button>
        </div>
      )}
      {canLead && !locked && openLeader && (
        <div className="border-border bg-muted/30 w-full space-y-1.5 rounded-md border p-2">
          <div className="flex flex-wrap items-center gap-1">
            <span className="text-muted-foreground text-[10px] uppercase">set status</span>
            {(["CONFIRM", "TENTATIVE", "LATE", "ABSENT"] as const).map((s) => (
              <button
                key={s}
                type="button"
                disabled={onBehalf.isPending}
                onClick={() => onBehalf.mutate({ eventId, characterId: m.characterId, state: s })}
                className="border-border hover:bg-muted rounded border px-1 py-0.5 text-xs"
                title={STATE_META[s].label}
              >
                {STATE_META[s].glyph}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-1">
            <span className="text-muted-foreground text-[10px] uppercase">selection</span>
            {(["STARTER", "BENCH", "CUT"] as const).map((sel) => (
              <button
                key={sel}
                type="button"
                disabled={setSel.isPending}
                onClick={() =>
                  setSel.mutate({
                    eventId,
                    characterId: m.characterId,
                    selection: m.selection === sel ? null : sel,
                  })
                }
                className={cn(
                  "border-border hover:bg-muted rounded border px-1.5 py-0.5 text-xs",
                  m.selection === sel && "bg-muted font-medium",
                )}
              >
                {sel.toLowerCase()}
              </button>
            ))}
          </div>
        </div>
      )}
    </li>
  );
}
