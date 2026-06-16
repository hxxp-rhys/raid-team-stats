-- Roster RANK (Main/Trial/Flex/Rotational/Social) on a team membership — the
-- raider's standing on the team, distinct from the site permission tier (role).
-- Nullable = unassigned, so existing rows need no backfill. Plus a new audit
-- event recorded when an officer changes a member's rank.

-- CreateEnum
CREATE TYPE "RaidRank" AS ENUM ('MAIN', 'TRIAL', 'FLEX', 'ROTATIONAL', 'SOCIAL');

-- AlterEnum
ALTER TYPE "AuditEvent" ADD VALUE 'RAID_TEAM_MEMBER_RANK_CHANGED';

-- AlterTable
ALTER TABLE "RaidTeamMembership" ADD COLUMN "rank" "RaidRank";
