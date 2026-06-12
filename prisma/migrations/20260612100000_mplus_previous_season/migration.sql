-- Raider.IO previous-season M+ score (+ its season slug) on MplusSnapshot.
-- Season-over-season churn signal for the engagement_pulse widget. Additive
-- and nullable: existing rows stay valid; the Tier-A sync starts populating
-- both columns on its next pass (the RIO fields CSV now requests
-- mythic_plus_scores_by_season:current:previous).
ALTER TABLE "MplusSnapshot"
  ADD COLUMN "previousSeasonRating" DECIMAL(8,2),
  ADD COLUMN "previousSeasonSlug" TEXT;
