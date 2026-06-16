-- Rolling rotation for the companion upload token (F8).
ALTER TABLE "User" ADD COLUMN "uploadTokenPrev" TEXT;
ALTER TABLE "User" ADD COLUMN "uploadTokenRotatedAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "uploadTokenLastUsedAt" TIMESTAMP(3);
CREATE UNIQUE INDEX "User_uploadTokenPrev_key" ON "User"("uploadTokenPrev");
