-- CreateTable
CREATE TABLE "DiscordIntegration" (
    "id" TEXT NOT NULL,
    "raidTeamId" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "reminderLeadsMinutes" INTEGER[] DEFAULT ARRAY[1440, 240]::INTEGER[],
    "reminderMode" TEXT NOT NULL DEFAULT 'CHANNEL',
    "installedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiscordIntegration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiscordLinkCode" (
    "code" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DiscordLinkCode_pkey" PRIMARY KEY ("code")
);

-- CreateIndex
CREATE UNIQUE INDEX "DiscordIntegration_raidTeamId_key" ON "DiscordIntegration"("raidTeamId");

-- CreateIndex
CREATE INDEX "DiscordLinkCode_userId_idx" ON "DiscordLinkCode"("userId");

-- CreateIndex
CREATE INDEX "DiscordLinkCode_expiresAt_idx" ON "DiscordLinkCode"("expiresAt");

-- AddForeignKey
ALTER TABLE "DiscordIntegration" ADD CONSTRAINT "DiscordIntegration_raidTeamId_fkey" FOREIGN KEY ("raidTeamId") REFERENCES "RaidTeam"("id") ON DELETE CASCADE ON UPDATE CASCADE;
