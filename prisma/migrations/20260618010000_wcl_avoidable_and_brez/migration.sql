-- AlterTable: battle-rez economy fields on the deaths layer
ALTER TABLE "WclFightDeath" ADD COLUMN "rezzedAt" TIMESTAMP(3);
ALTER TABLE "WclFightDeath" ADD COLUMN "rezzerActorId" INTEGER;
ALTER TABLE "WclFightDeath" ADD COLUMN "rezAbilityGameId" INTEGER;

-- CreateTable: avoidable-damage enrichment for learning_curve
CREATE TABLE "WclAvoidableDamage" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "encounterId" INTEGER NOT NULL,
    "difficulty" INTEGER NOT NULL,
    "bucket" INTEGER NOT NULL,
    "abilityGameId" INTEGER NOT NULL,
    "characterId" TEXT NOT NULL,
    "total" BIGINT NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WclAvoidableDamage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WclAvoidableDamage_full_unique" ON "WclAvoidableDamage"("guildId", "encounterId", "difficulty", "bucket", "abilityGameId", "characterId");

-- CreateIndex
CREATE INDEX "WclAvoidableDamage_guildId_encounterId_difficulty_idx" ON "WclAvoidableDamage"("guildId", "encounterId", "difficulty");

-- CreateTable: freshness/change-detector for the avoidable sweep
CREATE TABLE "WclAvoidableState" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "encounterId" INTEGER NOT NULL,
    "difficulty" INTEGER NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL,
    "wipeFights" INTEGER NOT NULL,

    CONSTRAINT "WclAvoidableState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WclAvoidableState_guildId_encounterId_difficulty_key" ON "WclAvoidableState"("guildId", "encounterId", "difficulty");

-- AddForeignKey
ALTER TABLE "WclAvoidableDamage" ADD CONSTRAINT "WclAvoidableDamage_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WclAvoidableDamage" ADD CONSTRAINT "WclAvoidableDamage_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "Character"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WclAvoidableState" ADD CONSTRAINT "WclAvoidableState_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE CASCADE ON UPDATE CASCADE;
