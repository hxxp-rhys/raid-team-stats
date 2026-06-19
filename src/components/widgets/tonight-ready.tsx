"use client";

import { useMemo, useState } from "react";

import { api } from "@/lib/trpc-client";
import { WidgetShell, WidgetEmpty, WidgetLoading, WidgetError } from "./shell";

/**
 * Raid-Night Readiness Board — at-a-glance "who's ready to pull". Per player,
 * pre-raid pillars derived from the latest snapshots: CONSUMABLES (flask /
 * pots / food on hand — addon-only) and GEAR HYGIENE (missing enchants /
 * gems — Blizzard). A FRESHNESS gate greys the addon pillar when its data is
 * stale, so the board never claims "ready" off an old bag scan. The header
 * tallies Ready / Needs-attention / Unknown and a copyable call-out lists who
 * needs what.
 */

type Pillar = "ready" | "attention" | "unknown";

// Lenient raid-prep thresholds (warn, don't block): a flask, a couple of
// combat pots, and some food on hand.
const MIN_FLASK = 1;
const MIN_POTS = 2;
const MIN_FOOD = 1;
// Addon bag scan older than this reads as "unknown" rather than "ready".
const STALE_MS = 6 * 60 * 60 * 1000;

const PILLAR_CLS: Record<Pillar, string> = {
  ready: "bg-emerald-500/80 text-white",
  attention: "bg-amber-500/85 text-black",
  unknown: "bg-muted text-muted-foreground",
};
const PILLAR_GLYPH: Record<Pillar, string> = {
  ready: "✓",
  attention: "!",
  unknown: "?",
};

export function TonightReadyWidget({ raidTeamId }: { raidTeamId: string }) {
  const q = api.snapshot.latestForTeam.useQuery({ raidTeamId });
  const [now] = useState(() => Date.now());

  const rows = useMemo(() => {
    if (!q.data) return [];
    return q.data.members.map((m) => {
      const cons = m.latest.addon?.consumables ?? null;
      const collectedAt = m.latest.addon?.collectedAt
        ? new Date(m.latest.addon.collectedAt).getTime()
        : null;
      const stale = collectedAt == null || now - collectedAt > STALE_MS;
      const ageH =
        collectedAt != null
          ? Math.floor((now - collectedAt) / 3_600_000)
          : null;

      // Consumables pillar.
      const missingCons: string[] = [];
      let consPillar: Pillar;
      if (!cons || stale) {
        consPillar = "unknown";
      } else {
        if (cons.flask < MIN_FLASK) missingCons.push("flask");
        if (cons.potion < MIN_POTS) missingCons.push("pots");
        if (cons.food < MIN_FOOD) missingCons.push("food");
        consPillar = missingCons.length === 0 ? "ready" : "attention";
      }

      // Gear hygiene pillar (Blizzard — essentially always present).
      const ench = m.latest.equipment?.missingEnchantsCount ?? null;
      const gem = m.latest.equipment?.missingGemsCount ?? null;
      const missingGear: string[] = [];
      let gearPillar: Pillar;
      if (ench == null && gem == null) {
        gearPillar = "unknown";
      } else {
        if ((ench ?? 0) > 0)
          missingGear.push(`${ench} enchant${ench === 1 ? "" : "s"}`);
        if ((gem ?? 0) > 0)
          missingGear.push(`${gem} gem${gem === 1 ? "" : "s"}`);
        gearPillar = missingGear.length === 0 ? "ready" : "attention";
      }

      const pillars = [consPillar, gearPillar];
      const overall: Pillar = pillars.includes("attention")
        ? "attention"
        : pillars.includes("unknown")
          ? "unknown"
          : "ready";

      const needs: string[] = [];
      if (consPillar === "attention")
        needs.push(`no ${missingCons.join("/")}`);
      if (gearPillar === "attention") needs.push(missingGear.join(", "));

      return {
        characterId: m.character.id,
        name: m.character.name,
        consPillar,
        consDetail: cons
          ? `flask ${cons.flask} · pots ${cons.potion} · food ${cons.food}`
          : "no addon data",
        gearPillar,
        gearDetail:
          gearPillar === "ready"
            ? "no missing enchants/gems"
            : missingGear.join(", ") || "no gear data",
        overall,
        needs,
        ageH,
        stale,
      };
    });
  }, [q.data, now]);

  const counts = useMemo(() => {
    let ready = 0,
      attention = 0,
      unknown = 0;
    for (const r of rows) {
      if (r.overall === "ready") ready++;
      else if (r.overall === "attention") attention++;
      else unknown++;
    }
    return { ready, attention, unknown };
  }, [rows]);

  if (q.isPending) {
    return (
      <WidgetShell title="Tonight ready" description={DESC} requiresCompanion>
        <WidgetLoading />
      </WidgetShell>
    );
  }
  if (q.error) {
    return (
      <WidgetShell title="Tonight ready" description={DESC} requiresCompanion>
        <WidgetError message={q.error.message} />
      </WidgetShell>
    );
  }
  if (rows.length === 0) {
    return (
      <WidgetShell title="Tonight ready" description={DESC} requiresCompanion>
        <WidgetEmpty>No tracked members yet.</WidgetEmpty>
      </WidgetShell>
    );
  }

  // Needs-attention first, then unknown, then ready.
  const order: Record<Pillar, number> = { attention: 0, unknown: 1, ready: 2 };
  const sorted = [...rows].sort((a, b) => order[a.overall] - order[b.overall]);
  const callouts = sorted.filter((r) => r.overall === "attention");

  return (
    <WidgetShell title="Tonight ready" description={DESC} requiresCompanion>
      <div className="mb-2 flex flex-wrap gap-3 text-xs">
        <Tally cls="text-emerald-500" label="Ready" n={counts.ready} />
        <Tally cls="text-amber-500" label="Needs attention" n={counts.attention} />
        <Tally cls="text-muted-foreground" label="Unknown" n={counts.unknown} />
      </div>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-muted-foreground border-border border-b text-left uppercase">
            <th className="py-1 pr-2 font-medium">Raider</th>
            <th className="py-1 pr-2 text-center font-medium">Cons.</th>
            <th className="py-1 pr-2 text-center font-medium">Gear</th>
            <th className="py-1 pl-2 text-right font-medium">Synced</th>
          </tr>
        </thead>
        <tbody className="divide-border divide-y">
          {sorted.map((r) => (
            <tr key={r.characterId}>
              <th scope="row" className="max-w-[9rem] truncate py-1 pr-2 text-left font-medium">
                {r.name}
              </th>
              <td className="py-1 pr-2 text-center">
                <PillarChip pillar={r.consPillar} detail={r.consDetail} />
              </td>
              <td className="py-1 pr-2 text-center">
                <PillarChip pillar={r.gearPillar} detail={r.gearDetail} />
              </td>
              <td
                className={`py-1 pl-2 text-right tabular-nums ${r.stale ? "text-amber-500" : "text-muted-foreground"}`}
                title={r.stale ? "Addon bag scan is stale — consumables shown as unknown" : "Addon data age"}
              >
                {r.ageH == null ? "—" : r.ageH === 0 ? "now" : `${r.ageH}h`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {callouts.length > 0 && (
        <p className="text-muted-foreground mt-2 text-[10px] leading-relaxed">
          <span className="font-medium">Call-out:</span>{" "}
          {callouts.map((r) => `${r.name} (${r.needs.join("; ")})`).join(" · ")}
        </p>
      )}
    </WidgetShell>
  );
}

const DESC =
  "Pre-raid readiness — consumables on hand + gear hygiene per player, with a Ready / Needs-attention tally. Consumables need the Raid Team Stats addon.";

function PillarChip({ pillar, detail }: { pillar: Pillar; detail: string }) {
  return (
    <span
      title={detail}
      className={`inline-flex size-4 items-center justify-center rounded-sm text-[10px] font-bold ${PILLAR_CLS[pillar]}`}
    >
      {PILLAR_GLYPH[pillar]}
    </span>
  );
}

function Tally({ cls, label, n }: { cls: string; label: string; n: number }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className={`font-semibold tabular-nums ${cls}`}>{n}</span>
      <span className="text-muted-foreground">{label}</span>
    </span>
  );
}
