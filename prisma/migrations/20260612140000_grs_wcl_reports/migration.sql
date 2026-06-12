-- Guild Report Sync (GRS): per-pull WCL combat-log ingestion tables.
-- WclReport (one per WCL report, frozen 48h after end), WclFight (one per
-- raid-encounter pull, replaced wholesale on re-fetch), WclReportActor
-- (report-local players, best-effort joined to Character).

CREATE TABLE "WclReport" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "zoneId" INTEGER,
    "title" TEXT,
    "startTime" TIMESTAMP(3) NOT NULL,
    "endTime" TIMESTAMP(3) NOT NULL,
    "revision" INTEGER NOT NULL,
    "frozen" BOOLEAN NOT NULL DEFAULT false,
    "fetchedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WclReport_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WclReport_code_key" ON "WclReport"("code");
CREATE INDEX "WclReport_guildId_startTime_idx" ON "WclReport"("guildId", "startTime" DESC);

CREATE TABLE "WclFight" (
    "id" TEXT NOT NULL,
    "reportCode" TEXT NOT NULL,
    "fightId" INTEGER NOT NULL,
    "encounterId" INTEGER NOT NULL,
    "difficulty" INTEGER NOT NULL,
    "kill" BOOLEAN NOT NULL,
    "size" INTEGER,
    "bossPct" DOUBLE PRECISION,
    "fightPct" DOUBLE PRECISION,
    "lastPhase" INTEGER,
    "lastPhaseIsIntermission" BOOLEAN,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "friendlyPlayerIds" INTEGER[] DEFAULT ARRAY[]::INTEGER[],

    CONSTRAINT "WclFight_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WclFight_reportCode_fightId_key" ON "WclFight"("reportCode", "fightId");
CREATE INDEX "WclFight_encounterId_difficulty_startAt_idx" ON "WclFight"("encounterId", "difficulty", "startAt" DESC);

CREATE TABLE "WclReportActor" (
    "id" TEXT NOT NULL,
    "reportCode" TEXT NOT NULL,
    "actorId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "server" TEXT,
    "subType" TEXT,
    "characterId" TEXT,

    CONSTRAINT "WclReportActor_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WclReportActor_reportCode_actorId_key" ON "WclReportActor"("reportCode", "actorId");
CREATE INDEX "WclReportActor_characterId_idx" ON "WclReportActor"("characterId");

ALTER TABLE "WclReport" ADD CONSTRAINT "WclReport_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WclFight" ADD CONSTRAINT "WclFight_reportCode_fkey" FOREIGN KEY ("reportCode") REFERENCES "WclReport"("code") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WclReportActor" ADD CONSTRAINT "WclReportActor_reportCode_fkey" FOREIGN KEY ("reportCode") REFERENCES "WclReport"("code") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WclReportActor" ADD CONSTRAINT "WclReportActor_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "Character"("id") ON DELETE SET NULL ON UPDATE CASCADE;
