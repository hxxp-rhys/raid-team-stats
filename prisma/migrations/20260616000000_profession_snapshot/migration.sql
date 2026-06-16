-- CreateTable
CREATE TABLE "ProfessionSnapshot" (
    "id" TEXT NOT NULL,
    "characterId" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" "SnapshotSource" NOT NULL,
    "sourceHash" TEXT NOT NULL,
    "professions" JSONB NOT NULL,
    "rawPayload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProfessionSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProfessionSnapshot_characterId_capturedAt_idx" ON "ProfessionSnapshot"("characterId", "capturedAt" DESC);

-- AddForeignKey
ALTER TABLE "ProfessionSnapshot" ADD CONSTRAINT "ProfessionSnapshot_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "Character"("id") ON DELETE CASCADE ON UPDATE CASCADE;
