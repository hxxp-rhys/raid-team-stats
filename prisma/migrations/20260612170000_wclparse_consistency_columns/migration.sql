-- parse_consistency widget: persist the consistency numbers the hourly WCL
-- sync always fetched but discarded — per-encounter season median percentile
-- and the zone-level best/median performance averages. Additive + nullable.
ALTER TABLE "WclParseSnapshot"
  ADD COLUMN "medianPercentile" DOUBLE PRECISION,
  ADD COLUMN "bestAvg" DOUBLE PRECISION,
  ADD COLUMN "medianAvg" DOUBLE PRECISION;
