-- Add leadership roster ranks (Officer, Raid Leader) to RaidRank. Appended to
-- the enum (Postgres ALTER TYPE ADD VALUE); existing rows are unaffected. The
-- dropdown order is controlled in the UI, not by the enum order.
ALTER TYPE "RaidRank" ADD VALUE 'OFFICER';
ALTER TYPE "RaidRank" ADD VALUE 'RAID_LEADER';
