-- Raid-lead targeting: authoritative ordered list (whole zones and/or single
-- bosses, in the planned kill order). The existing targetZoneIds /
-- targetEncounterIds arrays are now DERIVED from this and kept for back-compat.
-- Nullable: pre-migration rows have no order and readers fall back to the arrays.
ALTER TABLE "RaidEventSeries" ADD COLUMN     "targetOrder" JSONB;
ALTER TABLE "RaidEvent" ADD COLUMN     "targetOrder" JSONB;
