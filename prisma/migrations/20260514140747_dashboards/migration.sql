-- CreateTable
CREATE TABLE "DashboardConfig" (
    "id" TEXT NOT NULL,
    "raidTeamId" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "visibility" "RaidTeamVisibility" NOT NULL DEFAULT 'TEAM',
    "layout" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DashboardConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DashboardConfig_raidTeamId_idx" ON "DashboardConfig"("raidTeamId");

-- CreateIndex
CREATE INDEX "DashboardConfig_ownerUserId_idx" ON "DashboardConfig"("ownerUserId");

-- CreateIndex
CREATE UNIQUE INDEX "DashboardConfig_raidTeamId_slug_key" ON "DashboardConfig"("raidTeamId", "slug");

-- AddForeignKey
ALTER TABLE "DashboardConfig" ADD CONSTRAINT "DashboardConfig_raidTeamId_fkey" FOREIGN KEY ("raidTeamId") REFERENCES "RaidTeam"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DashboardConfig" ADD CONSTRAINT "DashboardConfig_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
