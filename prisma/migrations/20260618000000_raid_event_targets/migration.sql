-- Raid-lead zone/boss targeting on calendar events + series. Drives the
-- month-view zone-art day backgrounds. Additive + non-null with an empty
-- default so every existing row is "untargeted" with no backfill.
ALTER TABLE "RaidEvent"
  ADD COLUMN "targetZoneIds" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[],
  ADD COLUMN "targetEncounterIds" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[];

ALTER TABLE "RaidEventSeries"
  ADD COLUMN "targetZoneIds" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[],
  ADD COLUMN "targetEncounterIds" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[];
