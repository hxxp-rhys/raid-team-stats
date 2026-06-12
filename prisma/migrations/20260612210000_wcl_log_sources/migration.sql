-- Per-team Warcraft Logs source selection. Guild.wclGuildId = the guild's
-- resolved WCL guild id (lazy-cached default source); RaidTeam.wclGuildId/
-- wclGuildName = optional per-team override (+ display name from the
-- validation probe); WclReport.wclGuildId = which source a report was
-- discovered under (null = member-parse-swept, shared + participation-gated).
-- All additive + nullable.
ALTER TYPE "AuditEvent" ADD VALUE 'RAID_TEAM_WCL_SOURCE_CHANGED';
ALTER TYPE "AuditEvent" ADD VALUE 'RAID_TEAM_WCL_SOURCE_DATA_CLEARED';

ALTER TABLE "Guild" ADD COLUMN "wclGuildId" INTEGER;
ALTER TABLE "RaidTeam"
  ADD COLUMN "wclGuildId" INTEGER,
  ADD COLUMN "wclGuildName" TEXT;
ALTER TABLE "WclReport" ADD COLUMN "wclGuildId" INTEGER;
