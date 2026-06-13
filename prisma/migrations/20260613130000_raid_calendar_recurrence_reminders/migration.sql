-- AlterTable
ALTER TABLE "RaidEvent" ADD COLUMN     "seriesOverride" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "RaidTeam" ADD COLUMN     "reminderConfig" JSONB;

-- CreateTable
CREATE TABLE "SentReminder" (
    "id" TEXT NOT NULL,
    "raidEventId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SentReminder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SentReminder_raidEventId_idx" ON "SentReminder"("raidEventId");

-- CreateIndex
CREATE UNIQUE INDEX "SentReminder_raidEventId_kind_userId_key" ON "SentReminder"("raidEventId", "kind", "userId");

-- AddForeignKey
ALTER TABLE "SentReminder" ADD CONSTRAINT "SentReminder_raidEventId_fkey" FOREIGN KEY ("raidEventId") REFERENCES "RaidEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
