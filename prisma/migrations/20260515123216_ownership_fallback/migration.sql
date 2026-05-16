-- DropForeignKey
ALTER TABLE "DashboardConfig" DROP CONSTRAINT "DashboardConfig_ownerUserId_fkey";

-- DropForeignKey
ALTER TABLE "RaidTeam" DROP CONSTRAINT "RaidTeam_leaderUserId_fkey";

-- AlterTable
ALTER TABLE "DashboardConfig" ADD COLUMN     "pendingOwnerCharacterId" TEXT,
ALTER COLUMN "ownerUserId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "RaidTeam" ADD COLUMN     "pendingLeaderCharacterId" TEXT,
ALTER COLUMN "leaderUserId" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "DashboardConfig_pendingOwnerCharacterId_idx" ON "DashboardConfig"("pendingOwnerCharacterId");

-- CreateIndex
CREATE INDEX "RaidTeam_pendingLeaderCharacterId_idx" ON "RaidTeam"("pendingLeaderCharacterId");

-- AddForeignKey
ALTER TABLE "RaidTeam" ADD CONSTRAINT "RaidTeam_leaderUserId_fkey" FOREIGN KEY ("leaderUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RaidTeam" ADD CONSTRAINT "RaidTeam_pendingLeaderCharacterId_fkey" FOREIGN KEY ("pendingLeaderCharacterId") REFERENCES "Character"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DashboardConfig" ADD CONSTRAINT "DashboardConfig_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DashboardConfig" ADD CONSTRAINT "DashboardConfig_pendingOwnerCharacterId_fkey" FOREIGN KEY ("pendingOwnerCharacterId") REFERENCES "Character"("id") ON DELETE SET NULL ON UPDATE CASCADE;
