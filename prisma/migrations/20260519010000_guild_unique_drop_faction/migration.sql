-- A guild is a single faction. Keeping `faction` in the Guild unique key
-- meant a per-character faction misread (via per-member character-summary
-- guild attribution) minted a DUPLICATE Guild row for the same guild and
-- split its roster across two rows. Faction is now a plain attribute, not
-- part of the identity. Any pre-existing duplicate rows are merged in the
-- same release BEFORE this migration runs, so the new unique index holds.
DROP INDEX "Guild_region_realmSlug_guildSlug_faction_key";
CREATE UNIQUE INDEX "Guild_region_realmSlug_guildSlug_key" ON "Guild" ("region", "realmSlug", "guildSlug");
