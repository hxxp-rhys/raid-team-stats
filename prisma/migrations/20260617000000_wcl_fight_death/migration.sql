-- CreateTable
CREATE TABLE "WclFightDeath" (
    "id" TEXT NOT NULL,
    "reportCode" TEXT NOT NULL,
    "fightId" INTEGER NOT NULL,
    "encounterId" INTEGER NOT NULL,
    "difficulty" INTEGER NOT NULL,
    "kill" BOOLEAN NOT NULL,
    "targetActorId" INTEGER NOT NULL,
    "characterId" TEXT,
    "killerActorId" INTEGER,
    "killingAbilityGameId" INTEGER,
    "killingAbilityName" TEXT,
    "deathAt" TIMESTAMP(3) NOT NULL,
    "deathOrder" INTEGER NOT NULL,
    "overkill" BIGINT,

    CONSTRAINT "WclFightDeath_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WclFightDeath_encounterId_difficulty_deathAt_idx" ON "WclFightDeath"("encounterId", "difficulty", "deathAt" DESC);

-- CreateIndex
CREATE INDEX "WclFightDeath_characterId_idx" ON "WclFightDeath"("characterId");

-- CreateIndex
CREATE INDEX "WclFightDeath_reportCode_idx" ON "WclFightDeath"("reportCode");

-- CreateIndex
CREATE UNIQUE INDEX "WclFightDeath_reportCode_fightId_targetActorId_deathAt_key" ON "WclFightDeath"("reportCode", "fightId", "targetActorId", "deathAt");

-- AddForeignKey
ALTER TABLE "WclFightDeath" ADD CONSTRAINT "WclFightDeath_reportCode_fkey" FOREIGN KEY ("reportCode") REFERENCES "WclReport"("code") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WclFightDeath" ADD CONSTRAINT "WclFightDeath_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "Character"("id") ON DELETE SET NULL ON UPDATE CASCADE;
