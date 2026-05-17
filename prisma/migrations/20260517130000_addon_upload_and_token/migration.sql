-- AlterTable
ALTER TABLE "User" ADD COLUMN     "uploadToken" TEXT;

-- CreateTable
CREATE TABLE "AddonUpload" (
    "id" TEXT NOT NULL,
    "characterId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "collectedAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "addonVersion" TEXT,
    "raidUnlocked" INTEGER,
    "mplusUnlocked" INTEGER,
    "worldUnlocked" INTEGER,
    "worldTotal" INTEGER NOT NULL DEFAULT 3,
    "weeklyMplusRuns" INTEGER,
    "payload" JSONB NOT NULL,

    CONSTRAINT "AddonUpload_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AddonUpload_characterId_key" ON "AddonUpload"("characterId");

-- CreateIndex
CREATE INDEX "AddonUpload_userId_idx" ON "AddonUpload"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "User_uploadToken_key" ON "User"("uploadToken");

-- AddForeignKey
ALTER TABLE "AddonUpload" ADD CONSTRAINT "AddonUpload_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "Character"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AddonUpload" ADD CONSTRAINT "AddonUpload_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
