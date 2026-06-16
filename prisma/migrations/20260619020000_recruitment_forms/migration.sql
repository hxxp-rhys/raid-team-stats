-- Recruitment forms (Part 3) — config-driven brandable application forms per
-- guild/team, an officer review inbox, optional reviewer voting, and per-reviewer
-- opt-in notifications. All net-new tables; nothing to backfill.

-- CreateEnum
CREATE TYPE "RecruitFormStatus" AS ENUM ('DRAFT', 'OPEN', 'CLOSED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "RecruitSubmissionStatus" AS ENUM ('NEW', 'UNDER_REVIEW', 'TRIAL_OFFERED', 'ACCEPTED', 'DECLINED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "RecruitReviewerRole" AS ENUM ('REVIEWER', 'LEAD');

-- CreateEnum
CREATE TYPE "RecruitVoteValue" AS ENUM ('STRONG_NO', 'NO', 'YES', 'STRONG_YES', 'ABSTAIN');

-- CreateEnum
CREATE TYPE "RecruitVoteSource" AS ENUM ('WEB', 'DISCORD');

-- CreateEnum
CREATE TYPE "RecruitNotifyChannel" AS ENUM ('EMAIL', 'DISCORD_DM');

-- CreateEnum
CREATE TYPE "RecruitNotifyKind" AS ENUM ('NEW_SUBMISSION', 'STATUS_CHANGE', 'QUORUM_REACHED');

-- CreateTable
CREATE TABLE "RecruitmentForm" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "raidTeamId" TEXT,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "status" "RecruitFormStatus" NOT NULL DEFAULT 'DRAFT',
    "schema" JSONB NOT NULL,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "theme" JSONB,
    "votingEnabled" BOOLEAN NOT NULL DEFAULT false,
    "votingConfig" JSONB,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecruitmentForm_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FormSubmission" (
    "id" TEXT NOT NULL,
    "formId" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL,
    "status" "RecruitSubmissionStatus" NOT NULL DEFAULT 'NEW',
    "isDraft" BOOLEAN NOT NULL DEFAULT false,
    "applicantUserId" TEXT,
    "answersJson" JSONB NOT NULL,
    "applicantLabel" TEXT,
    "ipHash" TEXT,
    "submittedAt" TIMESTAMP(3),
    "discordChannelId" TEXT,
    "discordMessageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FormSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FormAnswer" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "fieldId" TEXT NOT NULL,
    "fieldType" TEXT NOT NULL,
    "valueText" TEXT,
    "valueNumber" DOUBLE PRECISION,
    "valueJson" JSONB,

    CONSTRAINT "FormAnswer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FormReviewer" (
    "id" TEXT NOT NULL,
    "formId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "RecruitReviewerRole" NOT NULL DEFAULT 'REVIEWER',
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FormReviewer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubmissionVote" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "reviewerUserId" TEXT NOT NULL,
    "value" "RecruitVoteValue" NOT NULL,
    "rationale" TEXT NOT NULL,
    "source" "RecruitVoteSource" NOT NULL DEFAULT 'WEB',
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubmissionVote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubmissionComment" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "authorUserId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubmissionComment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecruitmentNotificationPref" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "formId" TEXT,
    "channel" "RecruitNotifyChannel" NOT NULL,
    "onNew" BOOLEAN NOT NULL DEFAULT true,
    "onStatusChange" BOOLEAN NOT NULL DEFAULT false,
    "onQuorum" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "RecruitmentNotificationPref_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecruitmentNotificationOutbox" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "kind" "RecruitNotifyKind" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "RecruitmentNotificationOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RecruitmentForm_raidTeamId_idx" ON "RecruitmentForm"("raidTeamId");

-- CreateIndex
CREATE INDEX "RecruitmentForm_status_idx" ON "RecruitmentForm"("status");

-- CreateIndex
CREATE UNIQUE INDEX "RecruitmentForm_guildId_slug_key" ON "RecruitmentForm"("guildId", "slug");

-- CreateIndex
CREATE INDEX "FormSubmission_formId_status_idx" ON "FormSubmission"("formId", "status");

-- CreateIndex
CREATE INDEX "FormSubmission_formId_submittedAt_idx" ON "FormSubmission"("formId", "submittedAt" DESC);

-- CreateIndex
CREATE INDEX "FormAnswer_submissionId_idx" ON "FormAnswer"("submissionId");

-- CreateIndex
CREATE INDEX "FormAnswer_fieldId_idx" ON "FormAnswer"("fieldId");

-- CreateIndex
CREATE INDEX "FormReviewer_userId_idx" ON "FormReviewer"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "FormReviewer_formId_userId_key" ON "FormReviewer"("formId", "userId");

-- CreateIndex
CREATE INDEX "SubmissionVote_submissionId_idx" ON "SubmissionVote"("submissionId");

-- CreateIndex
CREATE UNIQUE INDEX "SubmissionVote_submissionId_reviewerUserId_key" ON "SubmissionVote"("submissionId", "reviewerUserId");

-- CreateIndex
CREATE INDEX "SubmissionComment_submissionId_idx" ON "SubmissionComment"("submissionId");

-- CreateIndex
CREATE INDEX "RecruitmentNotificationPref_formId_idx" ON "RecruitmentNotificationPref"("formId");

-- CreateIndex
CREATE UNIQUE INDEX "RecruitmentNotificationPref_userId_formId_channel_key" ON "RecruitmentNotificationPref"("userId", "formId", "channel");

-- CreateIndex
CREATE INDEX "RecruitmentNotificationOutbox_processedAt_idx" ON "RecruitmentNotificationOutbox"("processedAt");

-- CreateIndex
CREATE INDEX "RecruitmentNotificationOutbox_submissionId_idx" ON "RecruitmentNotificationOutbox"("submissionId");

-- AddForeignKey
ALTER TABLE "RecruitmentForm" ADD CONSTRAINT "RecruitmentForm_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecruitmentForm" ADD CONSTRAINT "RecruitmentForm_raidTeamId_fkey" FOREIGN KEY ("raidTeamId") REFERENCES "RaidTeam"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecruitmentForm" ADD CONSTRAINT "RecruitmentForm_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FormSubmission" ADD CONSTRAINT "FormSubmission_formId_fkey" FOREIGN KEY ("formId") REFERENCES "RecruitmentForm"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FormSubmission" ADD CONSTRAINT "FormSubmission_applicantUserId_fkey" FOREIGN KEY ("applicantUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FormAnswer" ADD CONSTRAINT "FormAnswer_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "FormSubmission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FormReviewer" ADD CONSTRAINT "FormReviewer_formId_fkey" FOREIGN KEY ("formId") REFERENCES "RecruitmentForm"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FormReviewer" ADD CONSTRAINT "FormReviewer_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubmissionVote" ADD CONSTRAINT "SubmissionVote_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "FormSubmission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubmissionVote" ADD CONSTRAINT "SubmissionVote_reviewerUserId_fkey" FOREIGN KEY ("reviewerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubmissionComment" ADD CONSTRAINT "SubmissionComment_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "FormSubmission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubmissionComment" ADD CONSTRAINT "SubmissionComment_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecruitmentNotificationPref" ADD CONSTRAINT "RecruitmentNotificationPref_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecruitmentNotificationPref" ADD CONSTRAINT "RecruitmentNotificationPref_formId_fkey" FOREIGN KEY ("formId") REFERENCES "RecruitmentForm"("id") ON DELETE CASCADE ON UPDATE CASCADE;
