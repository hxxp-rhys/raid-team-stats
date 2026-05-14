-- AlterEnum
ALTER TYPE "SnapshotSource" ADD VALUE 'WOWAUDIT';

-- AlterTable
ALTER TABLE "Guild" ADD COLUMN     "wowauditApiKey" TEXT,
ADD COLUMN     "wowauditBaseUrl" TEXT,
ADD COLUMN     "wowauditTeamId" TEXT;
