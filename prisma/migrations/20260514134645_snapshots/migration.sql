-- CreateEnum
CREATE TYPE "SnapshotSource" AS ENUM ('BLIZZARD', 'WARCRAFT_LOGS', 'RAIDERIO');

-- CreateTable
CREATE TABLE "CharacterSnapshot" (
    "id" TEXT NOT NULL,
    "characterId" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" "SnapshotSource" NOT NULL,
    "sourceHash" TEXT NOT NULL,
    "itemLevel" INTEGER,
    "level" INTEGER,
    "specId" INTEGER,
    "specName" TEXT,
    "loadoutText" TEXT,
    "rawPayload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CharacterSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EquipmentSnapshot" (
    "id" TEXT NOT NULL,
    "characterId" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" "SnapshotSource" NOT NULL,
    "sourceHash" TEXT NOT NULL,
    "itemLevel" INTEGER,
    "missingEnchantsCount" INTEGER,
    "missingGemsCount" INTEGER,
    "tierSetPiecesCount" INTEGER,
    "tierSetIds" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "items" JSONB NOT NULL,
    "rawPayload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EquipmentSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MplusSnapshot" (
    "id" TEXT NOT NULL,
    "characterId" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" "SnapshotSource" NOT NULL,
    "sourceHash" TEXT NOT NULL,
    "seasonId" INTEGER NOT NULL,
    "currentRating" DECIMAL(8,2),
    "weeklyHighest" INTEGER,
    "runsThisWeek" JSONB NOT NULL,
    "rawPayload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MplusSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RaidSnapshot" (
    "id" TEXT NOT NULL,
    "characterId" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" "SnapshotSource" NOT NULL,
    "sourceHash" TEXT NOT NULL,
    "expansionId" INTEGER,
    "tierId" INTEGER,
    "completions" JSONB NOT NULL,
    "rawPayload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RaidSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VaultSnapshot" (
    "id" TEXT NOT NULL,
    "characterId" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" "SnapshotSource" NOT NULL,
    "sourceHash" TEXT NOT NULL,
    "weekStart" TIMESTAMP(3) NOT NULL,
    "slots" JSONB NOT NULL,
    "rawPayload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VaultSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WclParseSnapshot" (
    "id" TEXT NOT NULL,
    "characterId" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" "SnapshotSource" NOT NULL,
    "sourceHash" TEXT NOT NULL,
    "zoneId" INTEGER NOT NULL,
    "encounterId" INTEGER NOT NULL,
    "difficulty" INTEGER NOT NULL,
    "percentile" INTEGER,
    "metric" TEXT,
    "reportCode" TEXT,
    "rawPayload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WclParseSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncRun" (
    "id" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "source" "SnapshotSource" NOT NULL,
    "guildId" TEXT,
    "characterId" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "ok" BOOLEAN NOT NULL DEFAULT false,
    "errorMessage" TEXT,
    "metrics" JSONB,

    CONSTRAINT "SyncRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CharacterSnapshot_characterId_capturedAt_idx" ON "CharacterSnapshot"("characterId", "capturedAt" DESC);

-- CreateIndex
CREATE INDEX "CharacterSnapshot_characterId_source_capturedAt_idx" ON "CharacterSnapshot"("characterId", "source", "capturedAt" DESC);

-- CreateIndex
CREATE INDEX "EquipmentSnapshot_characterId_capturedAt_idx" ON "EquipmentSnapshot"("characterId", "capturedAt" DESC);

-- CreateIndex
CREATE INDEX "MplusSnapshot_characterId_capturedAt_idx" ON "MplusSnapshot"("characterId", "capturedAt" DESC);

-- CreateIndex
CREATE INDEX "MplusSnapshot_characterId_seasonId_capturedAt_idx" ON "MplusSnapshot"("characterId", "seasonId", "capturedAt" DESC);

-- CreateIndex
CREATE INDEX "RaidSnapshot_characterId_capturedAt_idx" ON "RaidSnapshot"("characterId", "capturedAt" DESC);

-- CreateIndex
CREATE INDEX "VaultSnapshot_characterId_capturedAt_idx" ON "VaultSnapshot"("characterId", "capturedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "VaultSnapshot_characterId_weekStart_key" ON "VaultSnapshot"("characterId", "weekStart");

-- CreateIndex
CREATE INDEX "WclParseSnapshot_characterId_encounterId_difficulty_capture_idx" ON "WclParseSnapshot"("characterId", "encounterId", "difficulty", "capturedAt" DESC);

-- CreateIndex
CREATE INDEX "SyncRun_tier_startedAt_idx" ON "SyncRun"("tier", "startedAt" DESC);

-- CreateIndex
CREATE INDEX "SyncRun_guildId_startedAt_idx" ON "SyncRun"("guildId", "startedAt" DESC);

-- AddForeignKey
ALTER TABLE "CharacterSnapshot" ADD CONSTRAINT "CharacterSnapshot_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "Character"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EquipmentSnapshot" ADD CONSTRAINT "EquipmentSnapshot_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "Character"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MplusSnapshot" ADD CONSTRAINT "MplusSnapshot_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "Character"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RaidSnapshot" ADD CONSTRAINT "RaidSnapshot_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "Character"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VaultSnapshot" ADD CONSTRAINT "VaultSnapshot_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "Character"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WclParseSnapshot" ADD CONSTRAINT "WclParseSnapshot_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "Character"("id") ON DELETE CASCADE ON UPDATE CASCADE;
