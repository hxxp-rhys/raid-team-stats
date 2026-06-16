"use client";

import { useMemo } from "react";

import { api } from "@/lib/trpc-client";
import { wowClassColor } from "@/lib/wow";
import { STATE_META, type NightState } from "@/lib/attendance-ledger";
import { WidgetShell, WidgetEmpty, WidgetLoading, WidgetError } from "./shell";

/**
 * Attendance Ledger — who actually SHOWED, not just who signed up. A
 * character × raid-night grid of observed presence (from the in-game Stat
 * Smith addon), with a rolling attendance %. Signups (first-party calendar)
 * are shown alongside observed presence — never conflated — so "signed up but
 * no-show" is visible at a glance. Unobserved nights are excluded from the %.
 */

const MAX_NIGHTS = 16;

const STATE_CLASS: Record<NightState, string> = {
  present: "bg-emerald-500/80 text-white",
  late: "bg-amber-500/85 text-black",
  left_early: "bg-amber-400/70 text-black",
  absent: "bg-rose-500/25 text-rose-300",
  unobserved: "bg-muted text-muted-foreground",
};

const SIGNUP_LABEL: Record<string, string> = {
  CONFIRM: "Signed: confirmed",
  TENTATIVE: "Signed: tentative",
  LATE: "Signed: late",
  ABSENT: "Signed: absent",
};

const DESC =
  "Observed raid presence per night with a rolling attendance %, shown next to calendar signups — so signed-but-no-show is obvious. Needs the Stat Smith addon.";

const fmtNight = (ms: number): string =>
  new Date(ms).toLocaleDateString(undefined, {
    weekday: "short",
    month: "numeric",
    day: "numeric",
  });

export function AttendanceLedgerWidget({ raidTeamId }: { raidTeamId: string }) {
  const q = api.snapshot.attendanceLedger.useQuery({ raidTeamId });

  // Most-recent N nights (oldest→newest), with states sliced to match.
  const shown = useMemo(() => {
    if (!q.data) return null;
    const start = Math.max(0, q.data.nights.length - MAX_NIGHTS);
    return {
      nights: q.data.nights.slice(start),
      offset: start,
    };
  }, [q.data]);

  if (q.isPending) {
    return (
      <WidgetShell title="Attendance ledger" description={DESC}>
        <WidgetLoading />
      </WidgetShell>
    );
  }
  if (q.error) {
    return (
      <WidgetShell title="Attendance ledger" description={DESC}>
        <WidgetError message={q.error.message} />
      </WidgetShell>
    );
  }
  if (!q.data.hasObservations || !shown || shown.nights.length === 0) {
    return (
      <WidgetShell title="Attendance ledger" description={DESC} requiresCompanion>
        <WidgetEmpty>
          No observed raid nights yet. Attendance is recorded in-game by the
          Stat Smith addon — once an officer runs it during raid, who actually
          showed (and who signed up but didn&apos;t) appears here. Install it
          from your account page.
        </WidgetEmpty>
      </WidgetShell>
    );
  }

  const { nights, offset } = shown;
  const { memberMeta, members, signupsByNight, observerCount } = q.data;

  return (
    <WidgetShell title="Attendance ledger" description={DESC}>
      <div className="min-w-0 overflow-x-auto">
        <table className="w-full border-separate border-spacing-0 text-xs">
          <thead>
            <tr>
              <th className="text-muted-foreground sticky left-0 z-10 bg-[var(--card,inherit)] py-1 pr-2 text-left font-medium">
                {members.length} raiders
              </th>
              {nights.map((n) => (
                <th
                  key={n.key}
                  className="text-muted-foreground px-0.5 py-1 text-center font-normal align-bottom"
                  title={`${fmtNight(n.startedAt)}${n.instanceName ? ` · ${n.instanceName}` : ""}${n.difficulty ? ` (${n.difficulty})` : ""}${n.scheduled ? " · scheduled" : " · unscheduled"}`}
                >
                  <span className="block whitespace-nowrap text-[9px] leading-tight">
                    {fmtNight(n.startedAt)}
                  </span>
                </th>
              ))}
              <th className="text-muted-foreground py-1 pl-2 text-right font-medium">
                Att.
              </th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => {
              const meta = memberMeta[m.characterId];
              const name = meta?.name ?? "Unknown";
              const states = m.states.slice(offset);
              return (
                <tr key={m.characterId}>
                  <th
                    scope="row"
                    className="sticky left-0 z-10 max-w-[8rem] truncate bg-[var(--card,inherit)] py-0.5 pr-2 text-left font-medium"
                    style={{ color: wowClassColor(meta?.classId) }}
                  >
                    {name}
                  </th>
                  {nights.map((n, i) => {
                    const st = (states[i] ?? "unobserved") as NightState;
                    const signup = signupsByNight[n.key]?.[m.characterId];
                    // No-show: signed they'd come (confirm/late) but absent.
                    const noShow =
                      st === "absent" &&
                      (signup === "CONFIRM" || signup === "LATE");
                    return (
                      <td key={n.key} className="px-0.5 py-0.5 text-center">
                        <span
                          className={`mx-auto flex size-4 items-center justify-center rounded-sm text-[9px] font-bold ${STATE_CLASS[st]} ${noShow ? "ring-2 ring-rose-400" : ""}`}
                          title={`${name} · ${fmtNight(n.startedAt)} — ${STATE_META[st].label}${signup ? ` · ${SIGNUP_LABEL[signup] ?? signup}` : ""}${noShow ? " · NO-SHOW" : ""}`}
                        >
                          {STATE_META[st].glyph}
                        </span>
                      </td>
                    );
                  })}
                  <td className="py-0.5 pl-2 text-right tabular-nums">
                    {m.attendancePct == null ? (
                      <span className="text-muted-foreground" title="Need 3+ observed nights">
                        —
                      </span>
                    ) : (
                      <span
                        className={
                          m.attendancePct >= 90
                            ? "text-emerald-500"
                            : m.attendancePct >= 66
                              ? "text-amber-500"
                              : "text-rose-500"
                        }
                        title={`${m.present} present · ${m.late} late · ${m.leftEarly} left early · ${m.absent} absent of ${m.observedNights} observed`}
                      >
                        {Math.round(m.attendancePct)}%
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <Legend observerCount={observerCount} totalNights={q.data.nights.length} shown={nights.length} />
    </WidgetShell>
  );
}

function Legend({
  observerCount,
  totalNights,
  shown,
}: {
  observerCount: number;
  totalNights: number;
  shown: number;
}) {
  return (
    <div className="text-muted-foreground mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[9px]">
      <Swatch cls="bg-emerald-500/80" label="present" />
      <Swatch cls="bg-amber-500/85" label="late" />
      <Swatch cls="bg-amber-400/70" label="left early" />
      <Swatch cls="bg-rose-500/25" label="absent" />
      <span className="inline-flex items-center gap-1">
        <span className="size-2.5 rounded-sm ring-2 ring-rose-400" /> no-show
        (signed but absent)
      </span>
      <span className="ml-auto">
        {shown < totalNights ? `last ${shown} of ${totalNights} nights · ` : ""}
        {observerCount} observer{observerCount === 1 ? "" : "s"}
      </span>
    </div>
  );
}

function Swatch({ cls, label }: { cls: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className={`size-2.5 rounded-sm ${cls}`} />
      {label}
    </span>
  );
}
