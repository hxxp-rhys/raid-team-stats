# Suggested follow-ups

Things I noticed during the overnight pass that I deliberately did not
ship. Roughly ordered by impact-per-effort.

## High value, small change

1. **Push the overnight commits to `origin/main`.** I left them local
   so you could review first. `git log origin/main..HEAD` shows the
   delta — 18+ commits.
2. **Update `WCL_RAID_ZONE_ID` once Manaforge Omega → next tier rolls.**
   The Tier-A WCL ingestion defaults to zoneID 44 (Manaforge Omega).
   When the active raid changes:
   - Run `scripts/wcl-smoke.ts` to list current zone IDs.
   - Set `WCL_RAID_ZONE_ID` in `.env` (or compose env).
   - Tier A will start writing parses for the new zone.
3. **Verify the demo dashboard renders** for `cmp69ejay00005eofu07nhv2t`
   at `/guild/cmp68k01m000857qp7m37qsmq/team/.../dashboard/demo_eclipse`.
   Browse each of the 4 tabs.
4. **Pick a theme** — `/profile` has the selector. The `data-theme`
   cookie persists for a year. Parchment is the light-base variant.

## High value, medium change

5. **Add dedicated AuditEvent enum values** for the cases currently
   reusing other events (`DASHBOARD_CREATED`, `AUTH_EMAIL_VERIFIED`).
   Requires a Prisma migration + updating call sites. Search for
   `// reuse for now` in `src/server/api/routers/`.
6. **Wire Raider.IO ingestion**. Client stub exists at
   `src/server/ingestion/raiderio/client.ts`. Mostly duplicates
   Blizzard, but raid-progression rank percentile is RIO-unique.
7. **Persist encounter NAMES on `WclParseSnapshot`**. The
   parses_heatmap widget currently shows encounter id last-3-digits.
   Either: extend WCL query to fetch encounter names alongside
   rankings, or maintain a small in-code lookup table from id →
   name keyed on zoneID.

## Lower value / risky

8. **Tier B "tier-b-scheduler" placeholder userId.** Only used as a
   fallback when `guild.claimedByUserId` is null, which today's flow
   never produces. Worth tightening regardless (replace with a real
   "system" User row) to prevent a future regression.
9. **Eliminate the rest of the `process.env.X` direct reads** in
   favor of routing through `@/env`. Most are now consistent; check
   for stragglers in `scripts/` and `tests/`.
10. **Vault World track** still reports 0/0. Needs Delve/world-quest
    ingestion (not currently in Blizzard's character-summary).
11. **Expose tabbed dashboards in the share view** — already done in
    code but I didn't add a "create share link for tab X" affordance.
    Today the share view just walks all tabs.

## Pending follow-ups already noted in code

- `// reuse for now — dedicated DASHBOARD event in follow-up`
  → `src/server/api/routers/dashboard.ts:88`
- `// Phase 4.x remaining: …`
  → `src/server/ingestion/jobs/tracked-member-sync.ts` (most of these
  now done — only Raider.IO + world-vault remain)
- `// Phase 6` retention/compaction
  → `src/server/ingestion/snapshots.ts:17`

## Things I did NOT change

- No `git push origin`. No `--no-verify` on commits. No destructive
  ops on volumes or DB rows beyond the 25 RaidTeamMembership rows I
  inserted and the OWNER/ADMIN_CLAIMED elevation you authorized
  earlier.
- No schema migrations (kept all changes additive at the application
  layer — `DashboardConfig.layout` JSON now stores v2 shape, but
  v1 layouts still parse via the migrator).
- No edits to `prisma/schema.prisma`. All Prisma DDL is untouched
  this session.
