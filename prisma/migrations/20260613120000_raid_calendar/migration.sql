-- CreateEnum
CREATE TYPE "AttendanceState" AS ENUM ('CONFIRM', 'TENTATIVE', 'LATE', 'ABSENT');

-- CreateEnum
CREATE TYPE "SignupSource" AS ENUM ('WEBSITE', 'DISCORD', 'ADDON', 'LEADER');

-- CreateEnum
CREATE TYPE "RaidEventStatus" AS ENUM ('PLANNED', 'LOCKED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "RosterSelection" AS ENUM ('STARTER', 'BENCH', 'CUT');

-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'DISPATCHED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditEvent" ADD VALUE 'CALENDAR_EVENT_CREATED';
ALTER TYPE "AuditEvent" ADD VALUE 'CALENDAR_EVENT_UPDATED';
ALTER TYPE "AuditEvent" ADD VALUE 'CALENDAR_EVENT_CANCELLED';
ALTER TYPE "AuditEvent" ADD VALUE 'CALENDAR_SIGNUP_CHANGED';
ALTER TYPE "AuditEvent" ADD VALUE 'CALENDAR_ROSTER_LOCKED';

-- AlterTable
ALTER TABLE "RaidTeam" ADD COLUMN     "compTemplate" JSONB,
ADD COLUMN     "timezone" TEXT DEFAULT 'UTC';

-- CreateTable
CREATE TABLE "RaidEventSeries" (
    "id" TEXT NOT NULL,
    "raidTeamId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "difficulty" TEXT NOT NULL,
    "byday" TEXT[],
    "startLocal" TEXT NOT NULL,
    "durationMin" INTEGER NOT NULL,
    "timezone" TEXT NOT NULL,
    "raidSize" INTEGER,
    "notes" TEXT,
    "startsOn" TIMESTAMP(3),
    "endsOn" TIMESTAMP(3),
    "createdByUserId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RaidEventSeries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RaidEvent" (
    "id" TEXT NOT NULL,
    "raidTeamId" TEXT NOT NULL,
    "seriesId" TEXT,
    "title" TEXT NOT NULL,
    "difficulty" TEXT NOT NULL,
    "raidSize" INTEGER,
    "startsAt" TIMESTAMPTZ(6) NOT NULL,
    "durationMin" INTEGER NOT NULL,
    "timezone" TEXT NOT NULL,
    "localTime" TEXT NOT NULL,
    "occurrenceDate" TEXT NOT NULL,
    "notes" TEXT,
    "status" "RaidEventStatus" NOT NULL DEFAULT 'PLANNED',
    "rosterLockedAt" TIMESTAMP(3),
    "createdByUserId" TEXT,
    "discordGuildId" TEXT,
    "discordChannelId" TEXT,
    "discordMessageId" TEXT,
    "discordRepostLock" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RaidEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventSignup" (
    "id" TEXT NOT NULL,
    "raidEventId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "characterId" TEXT NOT NULL,
    "state" "AttendanceState" NOT NULL,
    "etaMinutes" INTEGER,
    "reason" TEXT,
    "comment" TEXT,
    "selection" "RosterSelection",
    "source" "SignupSource" NOT NULL,
    "updatedByUserId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EventSignup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncOutbox" (
    "id" BIGSERIAL NOT NULL,
    "raidTeamId" TEXT NOT NULL,
    "raidEventId" TEXT,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "version" INTEGER NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SyncOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcessedIntent" (
    "idempotencyKey" TEXT NOT NULL,
    "raidEventId" TEXT,
    "userId" TEXT,
    "version" INTEGER,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProcessedIntent_pkey" PRIMARY KEY ("idempotencyKey")
);

-- CreateTable
CREATE TABLE "DeliveryCursor" (
    "id" TEXT NOT NULL,
    "consumer" TEXT NOT NULL,
    "raidTeamId" TEXT NOT NULL,
    "lastOutboxId" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeliveryCursor_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RaidEventSeries_raidTeamId_isActive_idx" ON "RaidEventSeries"("raidTeamId", "isActive");

-- CreateIndex
CREATE INDEX "RaidEvent_raidTeamId_startsAt_idx" ON "RaidEvent"("raidTeamId", "startsAt");

-- CreateIndex
CREATE INDEX "RaidEvent_startsAt_idx" ON "RaidEvent"("startsAt");

-- CreateIndex
CREATE UNIQUE INDEX "RaidEvent_seriesId_occurrenceDate_key" ON "RaidEvent"("seriesId", "occurrenceDate");

-- CreateIndex
CREATE INDEX "EventSignup_raidEventId_state_idx" ON "EventSignup"("raidEventId", "state");

-- CreateIndex
CREATE INDEX "EventSignup_userId_idx" ON "EventSignup"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "EventSignup_raidEventId_characterId_key" ON "EventSignup"("raidEventId", "characterId");

-- CreateIndex
CREATE INDEX "SyncOutbox_status_id_idx" ON "SyncOutbox"("status", "id");

-- CreateIndex
CREATE INDEX "SyncOutbox_raidTeamId_id_idx" ON "SyncOutbox"("raidTeamId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryCursor_consumer_raidTeamId_key" ON "DeliveryCursor"("consumer", "raidTeamId");

-- AddForeignKey
ALTER TABLE "RaidEventSeries" ADD CONSTRAINT "RaidEventSeries_raidTeamId_fkey" FOREIGN KEY ("raidTeamId") REFERENCES "RaidTeam"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RaidEvent" ADD CONSTRAINT "RaidEvent_raidTeamId_fkey" FOREIGN KEY ("raidTeamId") REFERENCES "RaidTeam"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RaidEvent" ADD CONSTRAINT "RaidEvent_seriesId_fkey" FOREIGN KEY ("seriesId") REFERENCES "RaidEventSeries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventSignup" ADD CONSTRAINT "EventSignup_raidEventId_fkey" FOREIGN KEY ("raidEventId") REFERENCES "RaidEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventSignup" ADD CONSTRAINT "EventSignup_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventSignup" ADD CONSTRAINT "EventSignup_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "Character"("id") ON DELETE CASCADE ON UPDATE CASCADE;

