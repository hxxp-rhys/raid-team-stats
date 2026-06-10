-- Drop the WoW Audit integration entirely. The third-party dependency is
-- replaced by the Stat Smith in-game addon + companion uploader, which
-- writes World/Delve Vault data via the existing upload tables.
--
-- This migration:
--   (a) drops the three Guild.wowaudit* columns
--   (b) removes WOWAUDIT from the SnapshotSource enum (verified safe by
--       querying every *Snapshot table for any source='WOWAUDIT' rows —
--       zero across the board before this migration ran).
--
-- All statements are guarded so a partial prior apply can re-run cleanly.

ALTER TABLE "Guild" DROP COLUMN IF EXISTS "wowauditApiKey";
ALTER TABLE "Guild" DROP COLUMN IF EXISTS "wowauditTeamId";
ALTER TABLE "Guild" DROP COLUMN IF EXISTS "wowauditBaseUrl";

-- Postgres has no `ALTER TYPE ... DROP VALUE`. Recreate the enum and
-- re-cast every column that uses it. Safe because no rows store WOWAUDIT.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_enum e ON e.enumtypid = t.oid
    WHERE t.typname = 'SnapshotSource' AND e.enumlabel = 'WOWAUDIT'
  ) THEN
    ALTER TYPE "SnapshotSource" RENAME TO "SnapshotSource_old";
    CREATE TYPE "SnapshotSource" AS ENUM ('BLIZZARD', 'WARCRAFT_LOGS', 'RAIDERIO');
    ALTER TABLE "CharacterSnapshot"  ALTER COLUMN "source" TYPE "SnapshotSource" USING "source"::text::"SnapshotSource";
    ALTER TABLE "EquipmentSnapshot"  ALTER COLUMN "source" TYPE "SnapshotSource" USING "source"::text::"SnapshotSource";
    ALTER TABLE "MplusSnapshot"      ALTER COLUMN "source" TYPE "SnapshotSource" USING "source"::text::"SnapshotSource";
    ALTER TABLE "RaidSnapshot"       ALTER COLUMN "source" TYPE "SnapshotSource" USING "source"::text::"SnapshotSource";
    ALTER TABLE "VaultSnapshot"      ALTER COLUMN "source" TYPE "SnapshotSource" USING "source"::text::"SnapshotSource";
    ALTER TABLE "WclParseSnapshot"   ALTER COLUMN "source" TYPE "SnapshotSource" USING "source"::text::"SnapshotSource";
    ALTER TABLE "SyncRun"            ALTER COLUMN "source" TYPE "SnapshotSource" USING "source"::text::"SnapshotSource";
    DROP TYPE "SnapshotSource_old";
  END IF;
END
$$;
