-- CreateTable
CREATE TABLE "CompanionStatus" (
    "userId" TEXT NOT NULL,
    "installed" BOOLEAN NOT NULL DEFAULT false,
    "installedAt" TIMESTAMP(3),
    "uninstalledAt" TIMESTAMP(3),
    "lastSeenVersion" TEXT,
    "lastSeenAddonVersion" TEXT,
    "notifiedUpdateVersion" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CompanionStatus_pkey" PRIMARY KEY ("userId")
);

-- AddForeignKey
ALTER TABLE "CompanionStatus" ADD CONSTRAINT "CompanionStatus_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
