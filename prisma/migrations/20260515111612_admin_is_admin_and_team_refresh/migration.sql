-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditEvent" ADD VALUE 'RAID_TEAM_SETTINGS_UPDATED';
ALTER TYPE "AuditEvent" ADD VALUE 'ADMIN_USER_PROMOTED';
ALTER TYPE "AuditEvent" ADD VALUE 'ADMIN_USER_DEMOTED';

-- AlterTable
ALTER TABLE "RaidTeam" ADD COLUMN     "lastRefreshAt" TIMESTAMP(3),
ADD COLUMN     "memberCanRefresh" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "refreshSchedule" JSONB;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "isAdmin" BOOLEAN NOT NULL DEFAULT false;
