"use client";

import { useMemo, useState } from "react";

import { api } from "@/lib/trpc-client";
import { Modal } from "@/components/ui/modal";
import { Input } from "@/components/ui/input";
import { wowClassColor, wowClassName } from "@/lib/wow";
import {
  isMaxed,
  pivotPrimariesByProfession,
  type DerivedProfessions,
  type ProfEntry,
  type ProfTierInfo,
} from "@/lib/widgets/professions-logic";
import { WidgetShell, WidgetEmpty, WidgetLoading, WidgetError } from "./shell";

/**
 * Each member's professions: current-expansion-tier skill (X/Y) + known-recipe
 * count. Two views (raid-leader's choice): "by character" (the roster) and "by
 * profession" (who can craft X — including a coverage gap for professions no one
 * has). Accurate scope only — no fabricated coverage % or guessed craft lists.
 * Derivation + current-tier resolution are unit-tested in
 * src/lib/widgets/professions-logic.ts.
 */

const EMPTY: DerivedProfessions = { primaries: [], secondaries: [] };

function Skill({ t }: { t: ProfTierInfo | null }) {
  if (!t) return <span className="text-muted-foreground text-xs">not leveled</span>;
  return (
    <span className={"tabular-nums " + (isMaxed(t) ? "text-green-500" : "text-foreground")}>
      {t.skill}/{t.max}
    </span>
  );
}

function Recipes({ t }: { t: ProfTierInfo | null }) {
  if (!t || t.knownRecipes <= 0) return null;
  return (
    <span className="text-muted-foreground text-xs">· {t.knownRecipes} recipes</span>
  );
}

function ProfLine({ e }: { e: ProfEntry }) {
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-1.5">
      <span className="font-medium">{e.name}</span>
      <Skill t={e.current} />
      <Recipes t={e.current} />
    </span>
  );
}

/** Lightbox of a character's KNOWN recipes, grouped by the in-game categories
 *  (display order), with a search box. Lazily fetched on open. */
function RecipeModal({
  character,
  onClose,
}: {
  character: { id: string; name: string };
  onClose: () => void;
}) {
  const q = api.snapshot.professionRecipes.useQuery({ characterId: character.id });
  const [search, setSearch] = useState("");
  const needle = search.trim().toLowerCase();

  const filtered = useMemo(() => {
    if (!q.data) return [];
    return q.data.professions
      .map((prof) => ({
        ...prof,
        groups: prof.groups
          .map((g) => ({
            ...g,
            recipes: needle
              ? g.recipes.filter((r) => r.name.toLowerCase().includes(needle))
              : g.recipes,
          }))
          .filter((g) => g.recipes.length > 0),
      }))
      .filter((prof) => prof.groups.length > 0);
  }, [q.data, needle]);

  return (
    <Modal
      open
      onClose={onClose}
      title={`${character.name} — known recipes`}
      description="Grouped by the in-game profession categories."
      showCloseIcon
      hideDefaultFooter
    >
      <Input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search recipes…"
        className="mb-3"
        aria-label="Search recipes"
      />
      {q.isPending ? (
        <p className="text-muted-foreground text-sm">Loading…</p>
      ) : q.error ? (
        <p className="text-destructive text-sm" role="alert">{q.error.message}</p>
      ) : (q.data?.professions.length ?? 0) === 0 ? (
        <p className="text-muted-foreground text-sm">No known recipes.</p>
      ) : filtered.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No known recipes match “{search}”.
        </p>
      ) : (
        <div className="space-y-4">
          {filtered.map((prof) => (
            <section key={`${prof.kind}-${prof.profId}`}>
              <h3 className="bg-card border-border sticky top-0 z-10 border-b py-1 text-sm font-semibold">
                {prof.tierName}{" "}
                <span className="text-muted-foreground font-normal">
                  · {prof.recipeCount} recipes
                </span>
                {!prof.sortedLikeInGame && (
                  <span className="text-muted-foreground ml-1 text-xs">(alphabetical)</span>
                )}
              </h3>
              <div className="mt-1 space-y-2">
                {prof.groups.map((g) => (
                  <div key={g.category}>
                    <p className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
                      {g.category}
                    </p>
                    <ul className="mt-0.5 space-y-0.5">
                      {g.recipes.map((r) => (
                        <li key={r.id} className="text-sm">{r.name}</li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </Modal>
  );
}

/** True when the player has at least one current-tier known recipe to list. */
function hasAnyRecipes(d: DerivedProfessions): boolean {
  return [...d.primaries, ...d.secondaries].some(
    (e) => (e.current?.knownRecipes ?? 0) > 0,
  );
}

export function ProfessionsWidget({ raidTeamId }: { raidTeamId: string }) {
  const q = api.snapshot.latestForTeam.useQuery({ raidTeamId });
  const [view, setView] = useState<"character" | "profession">("character");
  const [showSecondaries, setShowSecondaries] = useState(false);
  const [recipesFor, setRecipesFor] = useState<{ id: string; name: string } | null>(
    null,
  );

  if (q.isPending) {
    return (
      <WidgetShell title="Professions">
        <WidgetLoading />
      </WidgetShell>
    );
  }
  if (q.error) {
    return (
      <WidgetShell title="Professions">
        <WidgetError message={q.error.message} />
      </WidgetShell>
    );
  }
  if (q.data.members.length === 0) {
    return (
      <WidgetShell title="Professions">
        <WidgetEmpty>No tracked members yet.</WidgetEmpty>
      </WidgetShell>
    );
  }

  const roster = q.data.members.map((m) => ({
    character: m.character,
    derived: (m.latest.professions as unknown as DerivedProfessions | null) ?? EMPTY,
  }));

  const viewToggle = (
    <div className="border-border inline-flex overflow-hidden rounded-md border text-xs">
      {(["character", "profession"] as const).map((v) => (
        <button
          key={v}
          type="button"
          onClick={() => setView(v)}
          aria-pressed={view === v}
          className={
            "px-2 py-0.5 font-medium transition-colors " +
            (view === v
              ? "bg-primary/15 text-foreground"
              : "text-muted-foreground hover:bg-muted")
          }
        >
          {v === "character" ? "By character" : "By profession"}
        </button>
      ))}
    </div>
  );

  return (
    <WidgetShell
      title="Professions"
      description="Current-tier skill + known-recipe count. Maxed = green."
      headerAction={viewToggle}
    >
      {view === "character" ? (
        <>
          <label className="text-muted-foreground mb-2 flex w-fit items-center gap-1.5 text-xs">
            <input
              type="checkbox"
              checked={showSecondaries}
              onChange={(e) => setShowSecondaries(e.target.checked)}
              className="accent-primary h-3.5 w-3.5"
            />
            Show secondaries
          </label>
          <table className="w-full text-sm">
            <caption className="sr-only">Professions by character</caption>
            <thead>
              <tr className="text-muted-foreground text-left text-xs uppercase">
                <th scope="col" className="py-1 pr-3 font-medium">Character</th>
                <th scope="col" className="py-1 pr-3 font-medium">Professions</th>
              </tr>
            </thead>
            <tbody className="divide-border divide-y">
              {roster.map(({ character, derived }) => {
                const entries = [
                  ...derived.primaries,
                  ...(showSecondaries ? derived.secondaries : []),
                ];
                return (
                  <tr key={character.id}>
                    <td className="py-1.5 pr-3 align-top">
                      <div>
                        <span
                          className="font-medium"
                          style={{ color: wowClassColor(character.classId) }}
                        >
                          {character.name}
                        </span>
                        <span className="text-muted-foreground ml-2 text-xs">
                          {wowClassName(character.classId)}
                        </span>
                      </div>
                      {hasAnyRecipes(derived) && (
                        <button
                          type="button"
                          onClick={() =>
                            setRecipesFor({
                              id: character.id,
                              name: character.name,
                            })
                          }
                          className="text-primary mt-0.5 text-xs underline-offset-2 hover:underline"
                        >
                          View recipes
                        </button>
                      )}
                    </td>
                    <td className="py-1.5 pr-3">
                      {entries.length === 0 ? (
                        <span className="text-muted-foreground text-xs">— none</span>
                      ) : (
                        <div className="flex flex-col gap-0.5">
                          {entries.map((e) => (
                            <ProfLine key={`${e.kind}-${e.id}`} e={e} />
                          ))}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      ) : (
        <ul className="divide-border divide-y text-sm">
          {pivotPrimariesByProfession(
            roster.map((r) => ({
              characterId: r.character.id,
              characterName: r.character.name,
              derived: r.derived,
            })),
          ).map(({ profession, crafters }) => (
            <li key={profession} className="py-1.5">
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-medium">{profession}</span>
                {crafters.length === 0 && (
                  <span className="text-destructive text-xs">no crafter</span>
                )}
              </div>
              {crafters.length > 0 && (
                <div className="mt-0.5 flex flex-col gap-0.5 pl-2">
                  {crafters.map(({ characterId, characterName, entry }) => (
                    <span
                      key={characterId}
                      className="inline-flex flex-wrap items-baseline gap-x-1.5"
                    >
                      <span>{characterName}</span>
                      <Skill t={entry.current} />
                      <Recipes t={entry.current} />
                    </span>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {recipesFor && (
        <RecipeModal character={recipesFor} onClose={() => setRecipesFor(null)} />
      )}
    </WidgetShell>
  );
}
