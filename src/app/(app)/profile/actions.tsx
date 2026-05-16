"use client";

import { useEffect, useRef, useState } from "react";
import { signIn, signOut } from "next-auth/react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { api } from "@/lib/trpc-client";

// Faux-progress steps shown while the discover mutation runs. The endpoint is
// a single round-trip on the wire, so we can't stream real progress — but the
// phases match what the server is doing internally, in roughly the right
// order, which gives the user a sense of motion rather than a frozen spinner.
const DISCOVERY_STEPS = [
  "Fetching characters from Battle.net…",
  "Loading character details per realm…",
  "Looking up guild rosters…",
  "Matching characters to guilds…",
] as const;

const STEP_INTERVAL_MS = 2500;

export function ProfileActions({ battlenetLinked }: { battlenetLinked: boolean }) {
  const [stepIndex, setStepIndex] = useState(0);
  // Reset the faux-progress step when a run starts — done in the mutation
  // lifecycle (not an effect) so we never call setState directly inside an
  // effect body (react-hooks/set-state-in-effect).
  const discover = api.guild.discoverFromBattlenet.useMutation({
    onMutate: () => setStepIndex(0),
  });

  // Detect the "just finished first link" redirect from the signIn callback
  // (?bnet=linked) and auto-run discovery once. The flag is stripped from the
  // URL after firing so navigation/refresh can't re-trigger it.
  // Reading window.location.search via useState avoids Next 16
  // cacheComponents' useSearchParams-needs-Suspense gotcha.
  const [justLinked] = useState(() => {
    if (typeof window === "undefined") return false;
    return new URLSearchParams(window.location.search).get("bnet") === "linked";
  });
  const autoFired = useRef(false);

  useEffect(() => {
    if (!justLinked || autoFired.current) return;
    if (!battlenetLinked) return;
    autoFired.current = true;
    // Strip the query param so a reload doesn't re-trigger.
    window.history.replaceState(null, "", "/account");
    discover.mutate();
  }, [justLinked, battlenetLinked, discover]);

  // While the mutation runs, advance the faux-progress label on an interval.
  // The reset-to-0 happens in the mutation's onMutate, so this effect only
  // ever sets state from inside the interval callback (allowed).
  useEffect(() => {
    if (!discover.isPending) return;
    const id = window.setInterval(() => {
      setStepIndex((i) => (i + 1 < DISCOVERY_STEPS.length ? i + 1 : i));
    }, STEP_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [discover.isPending]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-3">
        {battlenetLinked ? (
          <>
            <Button
              onClick={() => discover.mutate()}
              disabled={discover.isPending}
              variant="default"
            >
              {discover.isPending ? "Discovering…" : "Discover guilds from Battle.net"}
            </Button>
            <Link
              href="/guild"
              className="border-border bg-background hover:bg-muted inline-flex h-8 items-center justify-center rounded-lg border px-2.5 text-sm font-medium transition-colors"
            >
              My guilds
            </Link>
          </>
        ) : (
          <Button
            onClick={() => signIn("battlenet", { callbackUrl: "/account?bnet=linked" })}
            variant="default"
          >
            Link Battle.net
          </Button>
        )}
        <Button variant="outline" onClick={() => signOut({ callbackUrl: "/" })}>
          Sign out
        </Button>
      </div>

      {discover.isPending && (
        <div
          className="text-muted-foreground flex items-center gap-2 text-sm"
          role="status"
          aria-live="polite"
        >
          <span
            className="border-muted border-t-foreground inline-block size-3 animate-spin rounded-full border-2"
            aria-hidden
          />
          <span>{DISCOVERY_STEPS[stepIndex]}</span>
        </div>
      )}

      {discover.error && (
        <p className="text-destructive text-sm" role="alert">
          {discover.error.message}
        </p>
      )}

      {discover.data && !discover.isPending && (
        <div className="space-y-1 rounded-md border border-border bg-muted/40 p-3 text-sm">
          <p className="font-medium">
            Found {discover.data.guildsMatched} guild
            {discover.data.guildsMatched === 1 ? "" : "s"} from{" "}
            {discover.data.charactersObserved} character
            {discover.data.charactersObserved === 1 ? "" : "s"}.
          </p>
          {discover.data.autoClaims > 0 && (
            <p className="text-muted-foreground text-xs">
              Auto-claimed {discover.data.autoClaims} guild
              {discover.data.autoClaims === 1 ? "" : "s"} where you are the
              guild master.
            </p>
          )}
          {(discover.data.pendingTeamsClaimed > 0 ||
            discover.data.pendingDashboardsClaimed > 0) && (
            <p className="text-muted-foreground text-xs">
              Inherited{" "}
              {discover.data.pendingTeamsClaimed > 0 && (
                <>
                  {discover.data.pendingTeamsClaimed} raid team
                  {discover.data.pendingTeamsClaimed === 1 ? "" : "s"}
                </>
              )}
              {discover.data.pendingTeamsClaimed > 0 &&
                discover.data.pendingDashboardsClaimed > 0 &&
                " and "}
              {discover.data.pendingDashboardsClaimed > 0 && (
                <>
                  {discover.data.pendingDashboardsClaimed} dashboard
                  {discover.data.pendingDashboardsClaimed === 1 ? "" : "s"}
                </>
              )}{" "}
              that were waiting for you on signup.
            </p>
          )}
          {discover.data.guildsMatched > 0 && (
            <p className="text-muted-foreground text-xs">
              <Link
                href="/guild"
                className="text-primary underline-offset-4 hover:underline"
              >
                View your guilds →
              </Link>
            </p>
          )}
        </div>
      )}
    </div>
  );
}
