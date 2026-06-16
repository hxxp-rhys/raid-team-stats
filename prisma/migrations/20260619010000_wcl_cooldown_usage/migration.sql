-- Cooldown-usage layer on WclFightDeath (cooldown_usage widget). Additive +
-- all nullable, so existing death rows are simply "not yet computed" and the
-- self-healing backfill (cooldownsFetchedAt marker, mirroring deathsFetchedAt)
-- fills them in over the rolling window. No backfill needed at migrate time.
ALTER TABLE "WclFightDeath"
  ADD COLUMN "defensiveActiveGameId"     INTEGER,
  ADD COLUMN "defensiveActiveName"       TEXT,
  ADD COLUMN "lastDefensiveCastId"       INTEGER,
  ADD COLUMN "lastDefensiveCastMsBefore" INTEGER,
  ADD COLUMN "cooldownsFetchedAt"        TIMESTAMP(3);

-- Backfill sweep index: deaths whose cooldown layer hasn't been computed.
CREATE INDEX "WclFightDeath_cooldownsFetchedAt_idx"
  ON "WclFightDeath" ("cooldownsFetchedAt");
