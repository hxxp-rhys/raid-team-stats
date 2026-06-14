
-- AlterTable
ALTER TABLE "DiscordIntegration" ADD COLUMN     "autoPostEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "autoPostLeadDays" INTEGER NOT NULL DEFAULT 5;

