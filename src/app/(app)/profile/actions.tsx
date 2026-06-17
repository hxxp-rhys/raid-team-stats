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

/**
 * Sign out — lives on the right-hand side of the Account page header. Split
 * out from the Battle.net actions so the two concerns sit in their own
 * places on the page (sign-out top-right; Battle.net reconnect in its card).
 */
export function SignOutButton() {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="shrink-0"
      onClick={() => signOut({ callbackUrl: "/" })}
    >
      Sign out
    </Button>
  );
}

/**
 * Battle.net card body: connection status, the link/reconnect action pinned
 * bottom-right, and the one-shot guild auto-discovery feedback. "Reconnect"
 * re-runs Battle.net OAuth because its tokens expire ~24h with no refresh
 * token — re-authing keeps the per-character sync working.
 */
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
    // "reconnected" = re-auth to refresh an expired token; auto-run
    // discovery just like a first link so the fresh token is used now.
    const v = new URLSearchParams(window.location.search).get("bnet");
    return v === "linked" || v === "reconnected";
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
      {/* Connection status. The link/reconnect action is pinned bottom-right
          of the card (below), so the whole card reads: status → discovery
          feedback → action. */}
      <p className="text-sm">
        Status:{" "}
        <span
          className={battlenetLinked ? "text-green-500" : "text-muted-foreground"}
        >
          {battlenetLinked ? "Linked" : "Not linked"}
        </span>
      </p>

      {/* Guild discovery moved to the "Add Guild" lightbox on /guild, which
          lets the user pick WHICH guilds to add. Linking / reconnecting still
          auto-discovers once via the ?bnet=linked|reconnected redirect handled
          above. "My guilds" itself lives in the top bar, not on this page. */}

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

      {/* Primary action, pinned bottom-right of the Battle.net card. When NOT
          linked this is the "Link Battle.net" CTA; once linked it's the
          subtle "Reconnect" (re-runs OAuth — tokens expire ~24h). */}
      <div className="flex justify-end pt-1">
        {battlenetLinked ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              signIn("battlenet", { callbackUrl: "/account?bnet=reconnected" })
            }
            title="Re-run Battle.net sign-in to refresh the connection (tokens expire ~24h)"
          >
            Reconnect
          </Button>
        ) : (
          <Button
            variant="default"
            onClick={() =>
              signIn("battlenet", { callbackUrl: "/account?bnet=linked" })
            }
          >
            Link Battle.net
          </Button>
        )}
      </div>
    </div>
  );
}
