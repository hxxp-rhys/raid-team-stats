-- CreateTable
CREATE TABLE "WclZone" (
    "id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "frozen" BOOLEAN NOT NULL DEFAULT false,
    "expansionId" INTEGER,
    "expansionName" TEXT,
    "isRaid" BOOLEAN NOT NULL DEFAULT false,
    "isCurrentRaid" BOOLEAN NOT NULL DEFAULT false,
    "difficulties" JSONB NOT NULL,
    "encounters" JSONB NOT NULL,
    "refreshedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WclZone_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WclZone_frozen_idx" ON "WclZone"("frozen");

-- CreateIndex
CREATE INDEX "WclZone_isCurrentRaid_idx" ON "WclZone"("isCurrentRaid");
