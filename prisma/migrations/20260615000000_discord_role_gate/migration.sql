
-- Role-gate the /statsmith link command (and optionally the signup buttons) to a
-- Discord role. `requiredRoleId` null = open (current behaviour); `gateButtons`
-- only takes effect when a role is set. Both columns are additive and safe.

-- AlterTable
ALTER TABLE "DiscordIntegration" ADD COLUMN     "requiredRoleId" TEXT,
ADD COLUMN     "gateButtons" BOOLEAN NOT NULL DEFAULT false;
