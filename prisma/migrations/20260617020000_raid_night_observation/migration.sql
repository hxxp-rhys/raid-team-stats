-- CreateTable
CREATE TABLE "RaidNightObservation" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "observerCharacterId" TEXT NOT NULL,
    "uploadedByUserId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3) NOT NULL,
    "instanceName" TEXT,
    "difficulty" TEXT,
    "members" JSONB NOT NULL,
    "guildOnline" JSONB,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RaidNightObservation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RaidNightObservation_guildId_startedAt_idx" ON "RaidNightObservation"("guildId", "startedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "RaidNightObservation_observerCharacterId_sessionId_key" ON "RaidNightObservation"("observerCharacterId", "sessionId");

-- AddForeignKey
ALTER TABLE "RaidNightObservation" ADD CONSTRAINT "RaidNightObservation_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RaidNightObservation" ADD CONSTRAINT "RaidNightObservation_observerCharacterId_fkey" FOREIGN KEY ("observerCharacterId") REFERENCES "Character"("id") ON DELETE CASCADE ON UPDATE CASCADE;
