
-- Replace the gateButtons boolean with an independent buttonRoleId. The signup
-- buttons are now gated by their OWN role (null = open); a member may tap if
-- they hold the buttonRole, the link role (requiredRoleId), or are an admin.

-- AlterTable
ALTER TABLE "DiscordIntegration" DROP COLUMN "gateButtons",
ADD COLUMN     "buttonRoleId" TEXT;
