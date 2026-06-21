-- Calendar sharing: when true, a valid calendar share link serves the team's
-- calendar READ-ONLY to anonymous visitors. Off by default (links route but
-- don't grant access); flipping off re-locks outstanding links at resolve time.
ALTER TABLE "RaidTeam" ADD COLUMN     "calendarShareIsPublic" BOOLEAN NOT NULL DEFAULT false;
