-- AlterEnum
ALTER TYPE "AuditEvent" ADD VALUE 'ADMIN_SETTINGS_UPDATED';

-- CreateTable
CREATE TABLE "AdminSettings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "auditLogRetentionDays" INTEGER DEFAULT 90,
    "syncRunRetentionDays" INTEGER DEFAULT 14,
    "accessLogRetentionDays" INTEGER DEFAULT 30,
    "metricsRetentionDays" INTEGER DEFAULT 15,
    "loginFailureAlertThreshold" INTEGER NOT NULL DEFAULT 20,
    "loginFailureWindowMinutes" INTEGER NOT NULL DEFAULT 5,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedByUserId" TEXT,

    CONSTRAINT "AdminSettings_pkey" PRIMARY KEY ("id")
);
