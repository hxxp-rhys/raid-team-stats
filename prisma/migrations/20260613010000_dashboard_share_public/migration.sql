-- Public share links: owner-settable flag making a dashboard's share link
-- viewable WITHOUT sign-in (read-only; checked at resolve time so turning
-- it off re-locks outstanding links instantly). Additive, default false.
ALTER TABLE "DashboardConfig" ADD COLUMN "shareIsPublic" BOOLEAN NOT NULL DEFAULT false;
