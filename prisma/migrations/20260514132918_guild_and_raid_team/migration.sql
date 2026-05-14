-- CreateEnum
CREATE TYPE "Region" AS ENUM ('US', 'EU', 'KR', 'TW');

-- CreateEnum
CREATE TYPE "Faction" AS ENUM ('ALLIANCE', 'HORDE', 'NEUTRAL');

-- CreateEnum
CREATE TYPE "GuildClaimStatus" AS ENUM ('UNCLAIMED', 'GM_CLAIMED', 'ADMIN_CLAIMED');

-- CreateEnum
CREATE TYPE "GuildMemberRole" AS ENUM ('OWNER', 'OFFICER', 'MEMBER', 'PENDING');

-- CreateEnum
CREATE TYPE "GuildMembershipStatus" AS ENUM ('ACTIVE', 'PENDING', 'DEPARTED');

-- CreateEnum
CREATE TYPE "GuildCharacterLinkStatus" AS ENUM ('ACTIVE', 'DEPARTED');

-- CreateEnum
CREATE TYPE "RaidTeamVisibility" AS ENUM ('TEAM', 'GUILD', 'LINK');

-- CreateEnum
CREATE TYPE "RaidTeamMemberRole" AS ENUM ('LEADER', 'CO_LEADER', 'MEMBER');

-- CreateTable
CREATE TABLE "Character" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "blizzardCharacterId" BIGINT NOT NULL,
    "region" "Region" NOT NULL,
    "realmSlug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "classId" INTEGER,
    "race" TEXT,
    "faction" "Faction" NOT NULL,
    "level" INTEGER,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Character_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Guild" (
    "id" TEXT NOT NULL,
    "region" "Region" NOT NULL,
    "realmSlug" TEXT NOT NULL,
    "guildSlug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "faction" "Faction" NOT NULL,
    "claimStatus" "GuildClaimStatus" NOT NULL DEFAULT 'UNCLAIMED',
    "claimedByUserId" TEXT,
    "claimedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Guild_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GuildMembership" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "role" "GuildMemberRole" NOT NULL DEFAULT 'MEMBER',
    "status" "GuildMembershipStatus" NOT NULL DEFAULT 'PENDING',
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" TIMESTAMP(3),
    "approvedByUserId" TEXT,
    "departedAt" TIMESTAMP(3),

    CONSTRAINT "GuildMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GuildCharacterLink" (
    "id" TEXT NOT NULL,
    "characterId" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "rosterRank" INTEGER,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "GuildCharacterLinkStatus" NOT NULL DEFAULT 'ACTIVE',
    "consecutiveAbsences" INTEGER NOT NULL DEFAULT 0,
    "rejoinedAt" TIMESTAMP(3),
    "departedAt" TIMESTAMP(3),

    CONSTRAINT "GuildCharacterLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RaidTeam" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "leaderUserId" TEXT NOT NULL,
    "visibility" "RaidTeamVisibility" NOT NULL DEFAULT 'TEAM',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RaidTeam_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RaidTeamMembership" (
    "id" TEXT NOT NULL,
    "raidTeamId" TEXT NOT NULL,
    "characterId" TEXT NOT NULL,
    "role" "RaidTeamMemberRole" NOT NULL DEFAULT 'MEMBER',
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "addedByUserId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "removedAt" TIMESTAMP(3),
    "removalReason" TEXT,

    CONSTRAINT "RaidTeamMembership_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Character_blizzardCharacterId_key" ON "Character"("blizzardCharacterId");

-- CreateIndex
CREATE INDEX "Character_userId_idx" ON "Character"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Character_region_realmSlug_name_key" ON "Character"("region", "realmSlug", "name");

-- CreateIndex
CREATE INDEX "Guild_claimStatus_idx" ON "Guild"("claimStatus");

-- CreateIndex
CREATE UNIQUE INDEX "Guild_region_realmSlug_guildSlug_faction_key" ON "Guild"("region", "realmSlug", "guildSlug", "faction");

-- CreateIndex
CREATE INDEX "GuildMembership_guildId_status_idx" ON "GuildMembership"("guildId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "GuildMembership_userId_guildId_key" ON "GuildMembership"("userId", "guildId");

-- CreateIndex
CREATE INDEX "GuildCharacterLink_guildId_status_idx" ON "GuildCharacterLink"("guildId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "GuildCharacterLink_characterId_guildId_key" ON "GuildCharacterLink"("characterId", "guildId");

-- CreateIndex
CREATE INDEX "RaidTeam_leaderUserId_idx" ON "RaidTeam"("leaderUserId");

-- CreateIndex
CREATE UNIQUE INDEX "RaidTeam_guildId_slug_key" ON "RaidTeam"("guildId", "slug");

-- CreateIndex
CREATE INDEX "RaidTeamMembership_characterId_isActive_idx" ON "RaidTeamMembership"("characterId", "isActive");

-- CreateIndex
CREATE INDEX "RaidTeamMembership_raidTeamId_isActive_idx" ON "RaidTeamMembership"("raidTeamId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "RaidTeamMembership_raidTeamId_characterId_key" ON "RaidTeamMembership"("raidTeamId", "characterId");

-- AddForeignKey
ALTER TABLE "Character" ADD CONSTRAINT "Character_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Guild" ADD CONSTRAINT "Guild_claimedByUserId_fkey" FOREIGN KEY ("claimedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuildMembership" ADD CONSTRAINT "GuildMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuildMembership" ADD CONSTRAINT "GuildMembership_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuildMembership" ADD CONSTRAINT "GuildMembership_approvedByUserId_fkey" FOREIGN KEY ("approvedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuildCharacterLink" ADD CONSTRAINT "GuildCharacterLink_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "Character"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuildCharacterLink" ADD CONSTRAINT "GuildCharacterLink_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RaidTeam" ADD CONSTRAINT "RaidTeam_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RaidTeam" ADD CONSTRAINT "RaidTeam_leaderUserId_fkey" FOREIGN KEY ("leaderUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RaidTeamMembership" ADD CONSTRAINT "RaidTeamMembership_raidTeamId_fkey" FOREIGN KEY ("raidTeamId") REFERENCES "RaidTeam"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RaidTeamMembership" ADD CONSTRAINT "RaidTeamMembership_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "Character"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RaidTeamMembership" ADD CONSTRAINT "RaidTeamMembership_addedByUserId_fkey" FOREIGN KEY ("addedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
