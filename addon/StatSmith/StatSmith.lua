-- StatSmith.lua  (WoW Midnight 12.0.7 — Interface 120007)
--
-- Reads the player's live data that has NO Blizzard web API (Great Vault
-- incl. the World/Delve row + per-row thresholds & reward previews, exact
-- M+ weekly runs, held keystone, weekly raid lockouts, equipped enchants,
-- catalyst charges & upgrade currencies, tier pieces sitting in bags, delve
-- progression, raid consumable readiness) plus gear/talents, and writes it
-- to SavedVariables. WoW addons cannot make network requests, so the
-- companion desktop uploader reads the saved file and POSTs it to your
-- Raid Stats site. A copy/paste export string is also provided as a
-- no-companion fallback (/rts export).
--
-- Every collector is pcall-guarded (via safe()) AND feature-detects each
-- Blizzard API before calling it: one missing/renamed API on a given 12.0.x
-- patch never aborts the rest of the snapshot. Numeric enums/ids are dumped
-- raw so the server maps them by name (stable across patches).

local AddonName, ns = ...

-- SCHEMA 2: adds currencies, inventory (bag/bank), delves, lockouts,
-- consumables, per-activity vault reward previews, and ownedKeystone.
-- 1.1.1: Midnight 12.0.5 collector fixes — spec via C_SpecializationInfo,
-- talent configID from multiple sources, RequestRaidInfo() for lockouts.
-- 1.1.2: /dump on a live 12.0.5 client proved the APIs all WORK — the
-- failure was timing: collect() at login+8s / PLAYER_LOGOUT runs before
-- the server round-trips (keystone/lockouts/talents/delves) are back.
-- Fix: extra delayed login snapshots + a steady 60s in-session ticker so
-- the file the companion reads always has fully-loaded data. Also use the
-- confirmed delve names (GetActiveDelveTier / GetCompanionInfoForActivePlayer).
-- 1.1.3: rebranded to the StatSmith folder/TOC/SavedVariables (StatSmithDB,
-- /statsmith + /ss slash commands). Wire format (RTS1:) is unchanged.
-- 1.1.4: delve capture fixed against confirmed 12.0.5 returns —
-- GetActiveDelveTier is a table (use .tier), GetCompanionInfoForActivePlayer
-- is a bare number (Valeera's level). out.tier + out.companion.level.
-- 1.1.5: payload.complete (partial captures not sent/stored).
-- 1.1.6: completeness is now DATA-READINESS based, not a wall-clock
-- timer. The 1.1.5 timer reset on every /reload (PLAYER_LOGIN re-fires),
-- so a long session followed by the documented /reload+logout produced
-- complete=false. Now: complete = the server round-trips have actually
-- landed (UPDATE_INSTANCE_INFO seen + vault rows + M+ season known) —
-- which legit-empty states still satisfy and which survives /reload.
-- Belt-and-braces: the companion-facing export is NEVER overwritten by
-- an incomplete capture, so a /reload or short session can't regress
-- previously-good data.
-- 1.1.7: collectLockouts no longer calls RequestRaidInfo() (it is ASYNC;
-- calling it then reading on the same frame perpetually raced to
-- numEncounters=0 — proven on prod: complete=true uploads with all
-- lockouts enc=0). Request once at login + read the cached data later.
-- Completeness now also requires lockout encounter data to have actually
-- loaded (or zero saved instances), so a sparse capture can't be stamped
-- complete by the vault/season fast-path proxy.
-- SCHEMA 3 / 1.2.0: raidObserver — OBSERVED raid presence for the
-- attendance_ledger widget. No public API exposes who was actually in a raid
-- group, so an in-game observer (any officer running the addon) accumulates,
-- per raid SESSION, each raid member's first/last-seen + sample count +
-- online/subgroup/role/class, sampled on the existing 60s ticker and at every
-- ENCOUNTER_START/END. This is APPEND/accumulating data kept in a SEPARATE
-- persistent StatSmithDB.raidObserver table (NOT regenerated each collect),
-- and rides the normal export. The server upserts each session to
-- RaidNightObservation and unions observers at read time. Signups stay
-- first-party (the website calendar) — never inferred from presence.
-- 1.2.2: display name rebranded to "Raid Team Stats" (TOC Title/Author,
-- chat prefix, export-window title, login print). Folder/TOC/SavedVariables
-- (StatSmith / StatSmithDB), /statsmith + /ss commands and the wire format
-- (RTS1: export, complete flag) are UNCHANGED.
-- 1.2.3: in-game version readout — the login chat line now prints the addon
-- version (v" .. ADDON_VERSION), and a new `/statsmith version` (`/ss version`)
-- subcommand prints the version + schema for support. No wire-format change.
-- 1.2.4: rebranded the in-game slash commands to /raidteamstats + /rts (legacy /statsmith + /ss kept as aliases). No wire-format change.
-- 1.2.5: weekly M+ runs now carry the dungeon name (GetMapUIInfo); delve tier now reports the highest completed run for the season (best-effort) + captures the raw API return. No wire-format change.
-- 1.2.6: delve fixes. The Valeera column now shows her real companion LEVEL
-- (a Warband friendship rep: GetFactionForCompanion() with NO arg ->
-- C_GossipInfo.GetFriendshipReputationRanks().currentLevel), not the config ID
-- (GetCompanionInfoForActivePlayer) it was mislabeling as a level. Delve tier is
-- now a PERSISTED per-season high (no season-high API exists) built from the
-- active-delve tier + the weekly vault World row. Dropped the non-existent
-- GetHighestRunForCurrentSeason probe. No wire-format change.
local SCHEMA_VERSION = 3
local ADDON_VERSION = "1.2.6"
-- Flipped true by UPDATE_INSTANCE_INFO (raid-lockout data has round-
-- tripped — fires even with zero lockouts, the meaningful "ready" signal
-- that lagged in sparse captures). Re-armed each addon load/reload.
local sawInstanceInfo = false

-- ─── tiny dependency-free JSON encoder ──────────────────────────────────
local function jsonEncodeString(s)
  s = s:gsub('[%z\1-\31\\"]', function(c)
    local map = {
      ['"'] = '\\"', ['\\'] = '\\\\', ['\b'] = '\\b',
      ['\f'] = '\\f', ['\n'] = '\\n', ['\r'] = '\\r', ['\t'] = '\\t',
    }
    return map[c] or string.format('\\u%04x', string.byte(c))
  end)
  return '"' .. s .. '"'
end

local jsonEncode
jsonEncode = function(v)
  local t = type(v)
  if t == "nil" then
    return "null"
  elseif t == "boolean" then
    return v and "true" or "false"
  elseif t == "number" then
    if v ~= v or v == math.huge or v == -math.huge then return "null" end
    if math.floor(v) == v and math.abs(v) < 1e15 then
      return string.format("%d", v)
    end
    return string.format("%.14g", v)
  elseif t == "string" then
    return jsonEncodeString(v)
  elseif t == "table" then
    -- array iff keys are exactly 1..n
    local n, isArray = 0, true
    for k in pairs(v) do
      n = n + 1
      if type(k) ~= "number" or k ~= math.floor(k) or k <= 0 then
        isArray = false
      end
    end
    if isArray and n > 0 then
      for i = 1, n do
        if v[i] == nil then isArray = false break end
      end
    end
    local parts = {}
    if isArray and n > 0 then
      for i = 1, n do parts[#parts + 1] = jsonEncode(v[i]) end
      return "[" .. table.concat(parts, ",") .. "]"
    else
      for k, val in pairs(v) do
        parts[#parts + 1] = jsonEncodeString(tostring(k)) .. ":" .. jsonEncode(val)
      end
      return "{" .. table.concat(parts, ",") .. "}"
    end
  end
  return "null"
end

-- ─── base64 (for the copy/paste export string) ──────────────────────────
local B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
local function base64(data)
  return ((data:gsub(".", function(x)
    local r, b = "", x:byte()
    for i = 8, 1, -1 do r = r .. (b % 2 ^ i - b % 2 ^ (i - 1) > 0 and "1" or "0") end
    return r
  end) .. "0000"):gsub("%d%d%d?%d?%d?%d?", function(x)
    if #x < 6 then return "" end
    local c = 0
    for i = 1, 6 do c = c + (x:sub(i, i) == "1" and 2 ^ (6 - i) or 0) end
    return B64:sub(c + 1, c + 1)
  end) .. ({ "", "==", "=" })[#data % 3 + 1])
end

-- ─── data collectors (each pcall-guarded by collect()) ──────────────────
local REGION_CODE = { [1] = "us", [2] = "kr", [3] = "eu", [4] = "tw", [5] = "cn" }

-- Spec APIs moved to C_SpecializationInfo in 11.2.0; the bare globals
-- (GetSpecialization / GetSpecializationInfo) are deprecated and return
-- nil on 12.0.x. Probe the namespace first, fall back to the legacy
-- globals so the addon keeps working across every 12.0.x patch.
local function getSpecIndex()
  if C_SpecializationInfo and C_SpecializationInfo.GetSpecialization then
    local ok, v = pcall(C_SpecializationInfo.GetSpecialization)
    if ok and v then return v end
  end
  if GetSpecialization then
    local ok, v = pcall(GetSpecialization)
    if ok and v then return v end
  end
  return nil
end

-- Returns specId, specName for a spec index (C_SpecializationInfo.
-- GetSpecializationInfo and the legacy global both return id, name, ...).
local function getSpecInfo(idx)
  if not idx then return nil, nil end
  if C_SpecializationInfo and C_SpecializationInfo.GetSpecializationInfo then
    local ok, specId, specName = pcall(C_SpecializationInfo.GetSpecializationInfo, idx)
    if ok and (specId or specName) then return specId, specName end
  end
  if GetSpecializationInfo then
    local ok, specId, specName = pcall(GetSpecializationInfo, idx)
    if ok and (specId or specName) then return specId, specName end
  end
  return nil, nil
end

-- Stable SpecializationID for the talent/loadout APIs.
local function getCurrentSpecID()
  if PlayerUtil and PlayerUtil.GetCurrentSpecID then
    local ok, v = pcall(PlayerUtil.GetCurrentSpecID)
    if ok and v then return v end
  end
  return (getSpecInfo(getSpecIndex()))
end

local function collectIdentity()
  local name = UnitName("player")
  local realm = GetNormalizedRealmName() or GetRealmName()
  local _, classFile = UnitClass("player")
  local regionId = (GetCurrentRegion and GetCurrentRegion()) or 0
  local specId, specName = getSpecInfo(getSpecIndex())
  return {
    name = name,
    realm = realm,
    region = REGION_CODE[regionId] or tostring(regionId),
    class = classFile,
    spec = specName,
    specId = specId,
    level = UnitLevel("player"),
    faction = UnitFactionGroup("player"),
  }
end

-- Great Vault — the whole point. C_WeeklyRewards.GetActivities() returns
-- every row across all three categories (Raid / Mythic+ / World=Delves).
-- We store the raw fields + the numeric type so the server maps it (the
-- enum can shift between patches; numbers + a dumped enum are stable).
local function collectVault()
  local out = { activities = {}, hasRewards = nil, enum = {} }
  if not C_WeeklyRewards or not C_WeeklyRewards.GetActivities then
    return out
  end
  if C_WeeklyRewards.HasAvailableRewards then
    out.hasRewards = C_WeeklyRewards.HasAvailableRewards()
  end
  if Enum and Enum.WeeklyRewardChestThresholdType then
    for k, val in pairs(Enum.WeeklyRewardChestThresholdType) do
      out.enum[k] = val
    end
  end
  local acts = C_WeeklyRewards.GetActivities()
  if type(acts) == "table" then
    for _, a in ipairs(acts) do
      local entry = {
        type = a.type,
        index = a.index,
        threshold = a.threshold,
        progress = a.progress,
        level = a.level,
        id = a.id,
        claimID = a.claimID,
        raidString = a.raidString,
        unlocked = (type(a.progress) == "number"
          and type(a.threshold) == "number"
          and a.progress >= a.threshold) or false,
      }
      -- Reward preview per row (the projected item the slot would grant —
      -- useful even before the vault is claimable). itemLink encodes the
      -- ilvl; the upgrade link (2nd return) is the post-upgrade preview.
      if C_WeeklyRewards.GetExampleRewardItemHyperlinks and a.id ~= nil then
        local ok, itemLink, upgradeLink =
          pcall(C_WeeklyRewards.GetExampleRewardItemHyperlinks, a.id)
        if ok and (itemLink or upgradeLink) then
          entry.rewardExamples = { item = itemLink, upgrade = upgradeLink }
        end
      end
      out.activities[#out.activities + 1] = entry
    end
  end
  return out
end

-- Exact M+ runs THIS reset (repeats included) — Blizzard's web API only
-- exposes the deduped best-per-dungeon, so this is the authoritative count.
local function collectMythicPlus()
  local out = { weeklyRuns = {}, season = nil, ownedKeystone = nil }
  if C_MythicPlus then
    pcall(function() C_MythicPlus.RequestRewards() end)
    if C_MythicPlus.GetCurrentSeason then out.season = C_MythicPlus.GetCurrentSeason() end
    -- The keystone currently in the player's bag — NOT exposed by the
    -- Blizzard web API / Raider.IO (they only show completed runs). The
    -- getter name is current in 12.0 but the value needs RequestMapInfo()
    -- to be populated and may legitimately be absent (no key in the bag).
    -- Probe both getter spellings; accept nil silently.
    pcall(function() C_MythicPlus.RequestMapInfo() end)
    local mapId
    for _, fn in ipairs({
      "GetOwnedKeystoneChallengeMapID",
      "GetOwnedKeystoneMapID",
    }) do
      if type(C_MythicPlus[fn]) == "function" then
        local ok, v = pcall(C_MythicPlus[fn])
        if ok and v then mapId = v break end
      end
    end
    if mapId then
      local lvl
      if C_MythicPlus.GetOwnedKeystoneLevel then
        local ok2, l = pcall(C_MythicPlus.GetOwnedKeystoneLevel)
        if ok2 then lvl = l end
      end
      local mapName
      if C_ChallengeMode and C_ChallengeMode.GetMapUIInfo then
        local ok3, n = pcall(C_ChallengeMode.GetMapUIInfo, mapId)
        if ok3 then mapName = n end
      end
      out.ownedKeystone = { mapId = mapId, level = lvl, mapName = mapName }
    end
    if C_MythicPlus.GetRunHistory then
      local runs = C_MythicPlus.GetRunHistory(false, true) -- not previous weeks, this week
      if type(runs) == "table" then
        for _, r in ipairs(runs) do
          -- Resolve the dungeon name the same way the held keystone does
          -- (GetMapUIInfo returns the name as its first value) so weekly
          -- runs read "Nexus-Point Xenus +10", not a bare "+10".
          local mapName
          if C_ChallengeMode and C_ChallengeMode.GetMapUIInfo then
            local okN, n = pcall(C_ChallengeMode.GetMapUIInfo, r.mapChallengeModeID)
            if okN and type(n) == "string" then mapName = n end
          end
          out.weeklyRuns[#out.weeklyRuns + 1] = {
            mapId = r.mapChallengeModeID,
            mapName = mapName,
            level = r.level,
            completed = r.completed,
            runDateTime = r.runDateTime,
          }
        end
      end
    end
  end
  return out
end

-- Equipped items as Blizzard item links. The link encodes itemID, the
-- enchant id (field 2) and gem ids (fields 3-6) — the server parses it to
-- determine missing enchants per the Midnight slot rules. Slots 1..19.
local SLOT_NAME = {
  [1] = "HEAD", [2] = "NECK", [3] = "SHOULDER", [4] = "SHIRT",
  [5] = "CHEST", [6] = "WAIST", [7] = "LEGS", [8] = "FEET",
  [9] = "WRIST", [10] = "HANDS", [11] = "FINGER_1", [12] = "FINGER_2",
  [13] = "TRINKET_1", [14] = "TRINKET_2", [15] = "BACK",
  [16] = "MAIN_HAND", [17] = "OFF_HAND", [18] = "RANGED", [19] = "TABARD",
}
local function collectGear()
  local items = {}
  for slot = 1, 19 do
    local link = GetInventoryItemLink("player", slot)
    if link then
      local ilvl
      if C_Item and ItemLocation then
        local ok, loc = pcall(ItemLocation.CreateFromEquipmentSlot, slot)
        if ok and loc and C_Item.DoesItemExist(loc) then
          ilvl = C_Item.GetCurrentItemLevel(loc)
        end
      end
      items[#items + 1] = {
        slot = SLOT_NAME[slot] or tostring(slot),
        link = link,
        itemLevel = ilvl,
      }
    end
  end
  return { items = items, equippedItemLevel = select(2, GetAverageItemLevel()) }
end

-- Talent loadout export string. The API names (C_ClassTalents.
-- GetActiveConfigID + C_Traits.GenerateImportString) are CURRENT in
-- 12.0 — the real failure mode is GetActiveConfigID() returning nil
-- (player on an unsaved/starter build, or queried before the trait
-- config is live). Resolve a usable configID from several sources and
-- use the first that yields a non-empty import string.
local function collectTalents()
  local out = {}
  if not (C_ClassTalents and C_Traits and C_Traits.GenerateImportString) then
    return out
  end
  local specID = getCurrentSpecID()
  local candidates = {}
  if C_ClassTalents.GetActiveConfigID then
    local ok, cid = pcall(C_ClassTalents.GetActiveConfigID)
    if ok and cid then candidates[#candidates + 1] = cid end
  end
  if specID and C_ClassTalents.GetLastSelectedSavedConfigID then
    -- Returns -2 for a starter build; only real (> 0) ids are usable.
    local ok, cid = pcall(C_ClassTalents.GetLastSelectedSavedConfigID, specID)
    if ok and type(cid) == "number" and cid > 0 then
      candidates[#candidates + 1] = cid
    end
  end
  if specID and C_ClassTalents.GetConfigIDsBySpecID then
    local ok, ids = pcall(C_ClassTalents.GetConfigIDsBySpecID, specID)
    if ok and type(ids) == "table" then
      for _, cid in ipairs(ids) do candidates[#candidates + 1] = cid end
    end
  end
  for _, cid in ipairs(candidates) do
    local ok, str = pcall(C_Traits.GenerateImportString, cid)
    if ok and type(str) == "string" and str ~= "" then
      out.configId = cid
      out.importString = str
      return out
    end
  end
  out.configId = candidates[1] -- keep an id for debug even with no string
  return out
end

-- Catalyst charges + all upgrade/seasonal currencies (crests, valorstones,
-- coffer keys, sparks…). None are on the Blizzard web API. We dump the
-- live currency list raw (id+name+quantities) so the server maps by name —
-- stable when Blizzard renumbers currency ids between patches.
local function collectCurrencies()
  local out = {}
  if not C_CurrencyInfo or not C_CurrencyInfo.GetCurrencyListSize then
    return out
  end
  local size = C_CurrencyInfo.GetCurrencyListSize() or 0
  for i = 1, size do
    local info = C_CurrencyInfo.GetCurrencyListInfo
      and C_CurrencyInfo.GetCurrencyListInfo(i)
    if type(info) == "table" and not info.isHeader then
      local id
      if C_CurrencyInfo.GetCurrencyListLink and C_CurrencyInfo.GetCurrencyIDFromLink then
        local link = C_CurrencyInfo.GetCurrencyListLink(i)
        if link then
          local ok, cid = pcall(C_CurrencyInfo.GetCurrencyIDFromLink, link)
          if ok then id = cid end
        end
      end
      out[#out + 1] = {
        id = id,
        name = info.name,
        quantity = info.quantity,
        maxQuantity = info.maxQuantity,
        totalEarned = info.totalEarned,
        earnedThisWeek = info.quantityEarnedThisWeek,
      }
    end
  end
  return out
end

-- Equippable armor/weapons sitting in bags (and bank, when open). The
-- Blizzard API only sees EQUIPPED items, so this is the only way to know a
-- tier piece is owned-but-not-equipped (server reuses its link→tier logic).
local function collectInventory()
  local items, n = {}, 0
  if not C_Container or not C_Container.GetContainerNumSlots then
    return { items = items, scanned = 0 }
  end
  local bags = { 0, 1, 2, 3, 4 }
  if Enum and Enum.BagIndex then
    local extra = {
      Enum.BagIndex.ReagentBag,
      Enum.BagIndex.Bank,
      Enum.BagIndex.Reagentbank,
    }
    for _, b in ipairs(extra) do
      if b then bags[#bags + 1] = b end
    end
    if Enum.BagIndex.BankBag_1 then
      for b = Enum.BagIndex.BankBag_1, Enum.BagIndex.BankBag_1 + 6 do
        bags[#bags + 1] = b
      end
    end
  end
  for _, bag in ipairs(bags) do
    local slots = 0
    pcall(function() slots = C_Container.GetContainerNumSlots(bag) or 0 end)
    for slot = 1, slots do
      local link
      pcall(function() link = C_Container.GetContainerItemLink(bag, slot) end)
      if link then
        local _, _, _, equipLoc, _, classID = GetItemInfoInstant(link)
        -- classID 2 = Weapon, 4 = Armor — where tier/embellishments live.
        if equipLoc and equipLoc ~= "" and (classID == 2 or classID == 4) then
          n = n + 1
          if n <= 100 then
            items[#items + 1] = { link = link, bag = bag, slot = slot }
          end
        end
      end
    end
  end
  return { items = items, scanned = n }
end

-- Delve progression. API notes verified on Midnight 12.0.x via the live
-- warcraft.wiki C_DelvesUI inventory + a reference companion addon:
--   GetCurrentDelvesSeasonNumber()    -> number (season)
--   HasActiveDelve()                  -> bool
--   GetActiveDelveTier()              -> TABLE { tier=, ... } (tier 0 OUTSIDE a delve)
--   GetCompanionInfoForActivePlayer() -> number = the companion CONFIG ID (NOT a level)
--   GetFactionForCompanion(id)        -> the friendship factionID for that companion
-- The companion (Valeera) LEVEL is a Warband FRIENDSHIP reputation, read via
-- C_GossipInfo.GetFriendshipReputationRanks(factionID).currentLevel -- it is
-- NOT what GetCompanionInfoForActivePlayer returns (that is the config ID).
-- There is NO season-high delve-tier API (GetHighestRunForCurrentSeason does
-- NOT exist on this build -> it returned nil), so we PERSIST the max tier we
-- observe per season in StatSmithDB.delveHigh (same field-assign pattern as
-- raidObserver, so it survives the export write) and report that.
local function collectDelves()
  local out = {}
  if not C_DelvesUI then return out end
  out.api = {}
  for _, fn in ipairs({
    "GetCurrentDelvesSeasonNumber",
    "GetDelvesSeasonNumber",
    "HasActiveDelve",
  }) do
    if type(C_DelvesUI[fn]) == "function" then
      local ok, v = pcall(C_DelvesUI[fn])
      if ok and v ~= nil and type(v) ~= "table" then out.api[fn] = v end
    end
  end

  -- The delve TIER the player has reached. No API returns a season high, so
  -- gather what the client exposes RIGHT NOW and persist the max ourselves:
  --   * GetActiveDelveTier().tier  -- only while standing in a delve (else 0)
  --   * the weekly Great Vault World row's `level` -- this reset's delve tiers
  local observed = 0
  if type(C_DelvesUI.GetActiveDelveTier) == "function" then
    local ok, info = pcall(C_DelvesUI.GetActiveDelveTier)
    if ok and type(info) == "table" and type(info.tier) == "number" and info.tier > observed then
      observed = info.tier
    elseif ok and type(info) == "number" and info > observed then
      observed = info
    end
  end
  if C_WeeklyRewards and type(C_WeeklyRewards.GetActivities) == "function" then
    local worldType = Enum and Enum.WeeklyRewardChestThresholdType
      and Enum.WeeklyRewardChestThresholdType.World
    local okA, acts = pcall(C_WeeklyRewards.GetActivities)
    if okA and type(acts) == "table" then
      local wk = 0
      for _, a in ipairs(acts) do
        if type(a) == "table" and (worldType == nil or a.type == worldType)
           and type(a.level) == "number" and a.level > wk then
          wk = a.level
        end
      end
      out.tierThisWeek = wk -- diagnostic: this reset's best World/delve tier
      if wk > observed then observed = wk end
    end
  end

  -- Persist the season high (the game exposes no query for it). Reset on a new
  -- season. Field-assigned into StatSmithDB so it survives the export write.
  local season = out.api.GetCurrentDelvesSeasonNumber or out.api.GetDelvesSeasonNumber
  if type(season) == "number" then
    StatSmithDB = StatSmithDB or {}
    local dh = StatSmithDB.delveHigh
    if type(dh) ~= "table" or dh.season ~= season then dh = { season = season, tier = 0 } end
    if observed > (dh.tier or 0) then dh.tier = observed end
    StatSmithDB.delveHigh = dh
    if (dh.tier or 0) > 0 then out.tier = dh.tier end
  elseif observed > 0 then
    out.tier = observed
  end

  -- Delve companion (Valeera). The LEVEL is a Warband FRIENDSHIP reputation:
  --   GetFactionForCompanion()  -- NO argument = the active companion's faction
  --   -> C_GossipInfo.GetFriendshipReputationRanks(factionID).currentLevel
  -- GetCompanionInfoForActivePlayer() returns the companion CONFIG ID (e.g. 11),
  -- which is NEITHER the level NOR a valid GetFactionForCompanion argument
  -- (passing it returns faction 0). Confirmed live 12.0.7: no-arg faction = 2744,
  -- currentLevel = 60 (maxed). The config ID is kept only as a diagnostic. If any
  -- step is unavailable we leave companion.level nil (column shows "-") rather
  -- than reporting a fake value.
  out.companion = {}
  if type(C_DelvesUI.GetCompanionInfoForActivePlayer) == "function" then
    local okI, id = pcall(C_DelvesUI.GetCompanionInfoForActivePlayer)
    if okI and type(id) == "number" then out.companion.id = id end
  end
  if type(C_DelvesUI.GetFactionForCompanion) == "function" then
    local okF, factionID = pcall(C_DelvesUI.GetFactionForCompanion)
    if okF and type(factionID) == "number" and factionID > 0 then
      out.companion.factionID = factionID
      if C_GossipInfo and type(C_GossipInfo.GetFriendshipReputationRanks) == "function" then
        local okR, ranks = pcall(C_GossipInfo.GetFriendshipReputationRanks, factionID)
        if okR and type(ranks) == "table" then
          if type(ranks.currentLevel) == "number" then out.companion.level = ranks.currentLevel end
          if type(ranks.maxLevel) == "number" then out.companion.maxLevel = ranks.maxLevel end
        end
      end
    end
  end
  if not next(out.companion) then out.companion = nil end

  return out
end

-- Weekly raid/dungeon lockouts incl. per-boss kill state THIS reset.
-- Blizzard's web API only exposes season aggregates, not the live lockout.
-- CRITICAL: RequestRaidInfo() is ASYNC — GetSavedInstanceInfo's
-- numEncounters/per-boss data only populates AFTER it round-trips and
-- UPDATE_INSTANCE_INFO fires (proven via /dump: a 3s wait is required).
-- This collector must therefore NOT call RequestRaidInfo() itself —
-- doing so re-triggers the async fetch and the immediate read below
-- perpetually races to numEncounters=0. We request ONCE at login (and
-- re-snapshot on UPDATE_INSTANCE_INFO); by the time the ticker/logout
-- collect runs, the cached saved-instance data is fully populated and we
-- simply read it.
local function collectLockouts()
  local out = {}
  local num = 0
  pcall(function() num = GetNumSavedInstances() or 0 end)
  for i = 1, num do
    local ok, name, _id, reset, diffId, locked, extended, _msig, isRaid,
      maxPlayers, difficultyName, numEnc, encProgress =
      pcall(GetSavedInstanceInfo, i)
    if ok and name then
      local bosses = {}
      if numEnc and numEnc > 0 and GetSavedInstanceEncounterInfo then
        for e = 1, numEnc do
          local ok2, bossName, _fdid, isKilled =
            pcall(GetSavedInstanceEncounterInfo, i, e)
          if ok2 and bossName then
            bosses[#bosses + 1] = {
              name = bossName,
              killed = isKilled and true or false,
            }
          end
        end
      end
      out[#out + 1] = {
        name = name,
        isRaid = isRaid and true or false,
        difficulty = difficultyName,
        difficultyId = diffId,
        maxPlayers = maxPlayers,
        locked = locked and true or false,
        extended = extended and true or false,
        resetSeconds = reset,
        encounters = numEnc,
        progress = encProgress,
        bosses = bosses,
      }
    end
  end
  return out
end

-- Raid-prep consumables in bags (flasks/phials, potions, food, weapon
-- oils/runes, healthstones, augment runes…). Bag contents have no web API.
-- Aggregated per itemID with the raw consumable subclass so the server can
-- bucket "has flask / 2+ pots / food / weapon enhancement / healthstone".
local function collectConsumables()
  local byId = {}
  if not C_Container or not C_Container.GetContainerNumSlots then
    return { items = {} }
  end
  local bags = { 0, 1, 2, 3, 4 }
  if Enum and Enum.BagIndex and Enum.BagIndex.ReagentBag then
    bags[#bags + 1] = Enum.BagIndex.ReagentBag
  end
  for _, bag in ipairs(bags) do
    local slots = 0
    pcall(function() slots = C_Container.GetContainerNumSlots(bag) or 0 end)
    for slot = 1, slots do
      local itemID
      pcall(function() itemID = C_Container.GetContainerItemID(bag, slot) end)
      if itemID then
        local _, _, _, _, _, classID, subClassID = GetItemInfoInstant(itemID)
        if classID == 0 then -- Enum.ItemClass.Consumable
          local count = 1
          local info = C_Container.GetContainerItemInfo
            and C_Container.GetContainerItemInfo(bag, slot)
          if type(info) == "table" and info.stackCount then
            count = info.stackCount
          end
          local rec = byId[itemID]
          if rec then
            rec.count = rec.count + count
          else
            byId[itemID] = {
              id = itemID,
              name = (GetItemInfo(itemID)),
              sub = subClassID,
              count = count,
            }
          end
        end
      end
    end
  end
  local items = {}
  for _, rec in pairs(byId) do items[#items + 1] = rec end
  return { items = items }
end

-- ─── observed raid presence (attendance_ledger, SCHEMA 3) ───────────────
-- Accumulates, per raid SESSION, who was in the raid group and when. Unlike
-- every collector above (which snapshot the CURRENT state and are rebuilt
-- each collect), this APPENDS into a persistent StatSmithDB.raidObserver so a
-- whole night of presence survives across collect() calls and /reload. Each
-- 60s tick / ENCOUNTER event updates each present member's first/last-seen.
local SESSION_GAP = 2 * 60 * 60 -- >2h since the last sample starts a new night
local MAX_SESSIONS = 12 -- bound the payload — keep the most recent nights

local function pruneSessions(ro)
  local keys = {}
  for k, s in pairs(ro.sessions) do
    keys[#keys + 1] = { k = k, t = (s and s.startedAt) or 0 }
  end
  if #keys <= MAX_SESSIONS then return end
  table.sort(keys, function(a, b) return a.t > b.t end) -- newest first
  for i = MAX_SESSIONS + 1, #keys do
    ro.sessions[keys[i].k] = nil
  end
end

local function collectRaidPresence()
  if not (IsInRaid and IsInRaid()) then return end
  local now = time()
  StatSmithDB = StatSmithDB or {}
  StatSmithDB.raidObserver = StatSmithDB.raidObserver or { sessions = {} }
  local ro = StatSmithDB.raidObserver
  ro.sessions = ro.sessions or {}
  -- Session boundary: a >2h gap (or first ever sample) opens a new night.
  if not ro.currentSession or (now - (ro.lastSampleAt or 0)) > SESSION_GAP then
    ro.currentSession = now
  end
  ro.lastSampleAt = now
  local sid = tostring(ro.currentSession)
  local sess = ro.sessions[sid]
  if not sess then
    sess = { startedAt = ro.currentSession, endedAt = now, members = {} }
    ro.sessions[sid] = sess
    pruneSessions(ro)
  end
  sess.endedAt = now
  -- Instance context (best-effort): name + difficulty for the night label.
  if GetInstanceInfo then
    local ok, name, _itype, _diffId, diffName = pcall(GetInstanceInfo)
    if ok and name and name ~= "" then
      sess.instanceName = name
      if diffName and diffName ~= "" then sess.difficulty = diffName end
    end
  end
  -- Roster snapshot. GetRaidRosterInfo: name, rank, subgroup, level, class,
  -- fileName, zone, online, isDead, role, isML, combatRole.
  local n = (GetNumGroupMembers and GetNumGroupMembers()) or 0
  for i = 1, n do
    local name, _, subgroup, _, _, fileName, _, online, _, _, _, combatRole =
      GetRaidRosterInfo(i)
    if name and name ~= "" then
      local m = sess.members[name]
      if not m then
        m = { name = name, firstSeen = now, samples = 0 }
        sess.members[name] = m
      end
      m.lastSeen = now
      m.samples = m.samples + 1
      m.online = online and true or false
      m.subgroup = subgroup
      m.role = combatRole
      m.class = fileName
    end
  end
end

-- Convert the persistent keyed accumulation into the array shape the server
-- expects (luaArray-friendly). Returns nil when nothing has been observed.
local function buildRaidObserver()
  local ro = StatSmithDB and StatSmithDB.raidObserver
  if type(ro) ~= "table" or type(ro.sessions) ~= "table" then return nil end
  local sessions = {}
  for sid, s in pairs(ro.sessions) do
    if type(s) == "table" and type(s.members) == "table" then
      local members = {}
      for _, m in pairs(s.members) do
        members[#members + 1] = {
          name = m.name,
          firstSeen = m.firstSeen,
          lastSeen = m.lastSeen,
          samples = m.samples,
          online = m.online,
          subgroup = m.subgroup,
          role = m.role,
          class = m.class,
        }
      end
      if #members > 0 then
        sessions[#sessions + 1] = {
          sessionId = sid,
          startedAt = s.startedAt,
          endedAt = s.endedAt,
          instanceName = s.instanceName,
          difficulty = s.difficulty,
          members = members,
        }
      end
    end
  end
  if #sessions == 0 then return nil end
  return { sessions = sessions }
end

-- ─── assemble + persist ─────────────────────────────────────────────────
local function safe(fn, fallback)
  local ok, res = pcall(fn)
  if ok then return res end
  return fallback or {}
end

local function collect()
  -- Accumulate an observed-presence sample BEFORE assembling the payload, so
  -- the export carries the latest raid roster. Side-effects StatSmithDB
  -- .raidObserver (persistent); never throws (pcall-guarded).
  safe(collectRaidPresence)
  local payload = {
    schema = SCHEMA_VERSION,
    addonVersion = ADDON_VERSION,
    collectedAt = time(),
    character = safe(collectIdentity),
    vault = safe(collectVault),
    mythicPlus = safe(collectMythicPlus),
    gear = safe(collectGear),
    talents = safe(collectTalents),
    currencies = safe(collectCurrencies),
    inventory = safe(collectInventory),
    delves = safe(collectDelves),
    lockouts = safe(collectLockouts),
    consumables = safe(collectConsumables),
  }
  -- Observed raid presence (omitted entirely when nothing's been seen).
  local ro = safe(buildRaidObserver, nil)
  if type(ro) == "table" then payload.raidObserver = ro end
  -- "Complete" = the data that needs a Blizzard server round-trip has had
  -- its chance to land THIS session: UPDATE_INSTANCE_INFO has fired (raid
  -- lockouts settled — fires even with zero lockouts) AND the Great Vault
  -- rows are present AND the M+ season is known. These hold in every
  -- legit-empty state and re-establish within seconds after a /reload,
  -- so they don't false-negative the way the old 5-min timer did.
  local vaultRows = payload.vault and payload.vault.activities
    and #payload.vault.activities or 0
  -- Honest lockout readiness: if the player is saved to ANY instance, the
  -- capture isn't complete until its encounter data has actually loaded
  -- (>=1 lockout with encounters>0). Zero saved instances is a valid
  -- "ready & empty" state. This is the field that lagged while the old
  -- proxy gate falsely reported complete.
  local locks = payload.lockouts or {}
  local lockoutsReady = #locks == 0
  if not lockoutsReady then
    for _, l in ipairs(locks) do
      if type(l.encounters) == "number" and l.encounters > 0 then
        lockoutsReady = true
        break
      end
    end
  end
  local complete = sawInstanceInfo
    and vaultRows > 0
    and payload.mythicPlus ~= nil
    and payload.mythicPlus.season ~= nil
    and lockoutsReady
    and true
    or false
  payload.complete = complete
  local json = jsonEncode(payload)
  StatSmithDB = StatSmithDB or {}
  StatSmithDB.schema = SCHEMA_VERSION
  StatSmithDB.payload = payload      -- structured (debug/inspection) — always
  ns.lastJson = json
  -- NEVER regress: only update what the companion reads (export/json/
  -- collectedAt) when this capture is complete. A /reload or short
  -- session can't overwrite a previously-good capture with a partial one.
  if complete then
    StatSmithDB.collectedAt = payload.collectedAt
    StatSmithDB.json = json
    StatSmithDB.export = "RTS1:" .. base64(json)
  end
  return payload
end
ns.collect = collect

-- ─── export UI (copy/paste fallback) ────────────────────────────────────
local exportFrame
local function showExport()
  collect()
  if not exportFrame then
    local f = CreateFrame("Frame", "StatSmithExportFrame", UIParent, "BackdropTemplate")
    f:SetSize(560, 170)
    f:SetPoint("CENTER")
    f:SetFrameStrata("DIALOG")
    f:SetMovable(true)
    f:EnableMouse(true)
    f:RegisterForDrag("LeftButton")
    f:SetScript("OnDragStart", f.StartMoving)
    f:SetScript("OnDragStop", f.StopMovingOrSizing)
    if f.SetBackdrop then
      f:SetBackdrop({
        bgFile = "Interface\\DialogFrame\\UI-DialogBox-Background",
        edgeFile = "Interface\\DialogFrame\\UI-DialogBox-Border",
        edgeSize = 16,
        insets = { left = 4, right = 4, top = 4, bottom = 4 },
      })
    end
    local title = f:CreateFontString(nil, "OVERLAY", "GameFontHighlight")
    title:SetPoint("TOP", 0, -12)
    title:SetText("Raid Team Stats — copy this, then paste it on the website")
    local sf = CreateFrame("ScrollFrame", nil, f, "UIPanelScrollFrameTemplate")
    sf:SetPoint("TOPLEFT", 16, -36)
    sf:SetPoint("BOTTOMRIGHT", -34, 40)
    local eb = CreateFrame("EditBox", nil, sf)
    eb:SetMultiLine(true)
    eb:SetFontObject(ChatFontNormal)
    eb:SetWidth(500)
    eb:SetAutoFocus(false)
    eb:SetScript("OnEscapePressed", function() f:Hide() end)
    sf:SetScrollChild(eb)
    f.editBox = eb
    local close = CreateFrame("Button", nil, f, "UIPanelButtonTemplate")
    close:SetSize(80, 22)
    close:SetPoint("BOTTOM", 0, 12)
    close:SetText("Close")
    close:SetScript("OnClick", function() f:Hide() end)
    local hint = f:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
    hint:SetPoint("BOTTOMLEFT", 16, 16)
    hint:SetText("Ctrl+A then Ctrl+C")
    exportFrame = f
  end
  exportFrame.editBox:SetText(StatSmithDB.export or "")
  exportFrame.editBox:HighlightText()
  exportFrame.editBox:SetFocus()
  exportFrame:Show()
end

-- ─── slash command ──────────────────────────────────────────────────────
local PREFIX = "|cff39c5bbRaid Team Stats|r: "
local function printHelp()
  print(PREFIX .. "commands (also /raidteamstats; legacy /statsmith and /ss still work) —")
  print("  /rts export  — collect a fresh snapshot and open the copy/paste export window")
  print("  /rts now     — collect a fresh snapshot silently (the companion app uploads it)")
  print("  /rts status  — show when the last snapshot was taken")
  print("  /rts version — show the installed addon version")
  print("  /rts help    — show this list")
end

SlashCmdList["STATSMITH"] = function(msg)
  local cmd = strtrim(msg or ""):lower()
  if cmd == "now" then
    local p = collect()
    print(PREFIX .. "snapshot collected for " ..
      (p.character and p.character.name or "?") ..
      ". It uploads automatically; use /rts export to copy it manually.")
  elseif cmd == "status" then
    local at = StatSmithDB and StatSmithDB.collectedAt
    print(PREFIX .. "last snapshot " ..
      (at and date("%Y-%m-%d %H:%M", at) or "never") ..
      ". The companion app uploads the saved file.")
  elseif cmd == "version" or cmd == "ver" then
    print(PREFIX .. "|cff39c5bbRaid Team Stats|r v" .. ADDON_VERSION ..
      " (schema " .. SCHEMA_VERSION .. ")")
  elseif cmd == "export" or cmd == "show" or cmd == "copy" then
    -- Initiate a manual data export: collect a fresh snapshot, then open
    -- the copy/paste window (also rewrites SavedVariables so the companion
    -- picks it up immediately).
    showExport()
    print(PREFIX .. "fresh snapshot exported — Ctrl+A, Ctrl+C, then paste it on the website.")
  else
    printHelp()
  end
end
-- Branded commands + legacy aliases (/statsmith, /ss) — all map to SlashCmdList["STATSMITH"].
SLASH_STATSMITH1 = "/raidteamstats"
SLASH_STATSMITH2 = "/rts"
SLASH_STATSMITH3 = "/statsmith"
SLASH_STATSMITH4 = "/ss"

-- ─── lifecycle ──────────────────────────────────────────────────────────
local refreshTicker -- steady in-session re-snapshot (server data lands late)
local ev = CreateFrame("Frame")
ev:RegisterEvent("ADDON_LOADED")
ev:RegisterEvent("PLAYER_LOGIN")
ev:RegisterEvent("PLAYER_LOGOUT")
ev:RegisterEvent("WEEKLY_REWARDS_UPDATE")
ev:RegisterEvent("CHALLENGE_MODE_COMPLETED")
ev:RegisterEvent("PLAYER_EQUIPMENT_CHANGED")
-- Re-snapshot when the server delivers data that isn't ready at login:
-- raid lockouts (UPDATE_INSTANCE_INFO) and the talent loadout
-- (TRAIT_CONFIG_UPDATED / PLAYER_TALENT_UPDATE).
ev:RegisterEvent("UPDATE_INSTANCE_INFO")
ev:RegisterEvent("TRAIT_CONFIG_UPDATED")
ev:RegisterEvent("PLAYER_TALENT_UPDATE")
-- Pull boundaries — sample observed presence at the start/end of every
-- encounter (the 60s ticker covers the rest of the night).
ev:RegisterEvent("ENCOUNTER_START")
ev:RegisterEvent("ENCOUNTER_END")
ev:SetScript("OnEvent", function(self, event, arg1)
  if event == "ADDON_LOADED" and arg1 == AddonName then
    StatSmithDB = StatSmithDB or {}
    self:UnregisterEvent("ADDON_LOADED")
  elseif event == "PLAYER_LOGIN" then
    -- Ask the client to populate the data that needs a server round-trip
    -- (vault, M+ rewards/keystone, AND raid lockouts) BEFORE the first
    -- snapshot. Without RequestRaidInfo() the saved-instance list reports
    -- numEncounters=0 with no per-boss state. UPDATE_INSTANCE_INFO and the
    -- talent events re-snapshot when that data lands, so the logout file
    -- the companion reads is complete.
    pcall(function() C_MythicPlus.RequestRewards() end)
    pcall(function() C_MythicPlus.RequestMapInfo() end)
    pcall(function() C_WeeklyRewards.CanClaimRewards() end)
    pcall(RequestRaidInfo)
    -- The data behind keystone/lockouts/talents/delves all needs a server
    -- round-trip that ISN'T back at +8s, and the PLAYER_LOGOUT snapshot is
    -- too late for those round-trips to finish. So snapshot a few times
    -- after login AND keep a steady 60s ticker running the whole session —
    -- the companion (watch mode, every 5 min) then always reads a file
    -- whose server-sourced fields are fully populated, regardless of how
    -- briefly the player was online.
    C_Timer.After(8, collect)
    C_Timer.After(25, collect)
    if not refreshTicker then
      refreshTicker = C_Timer.NewTicker(60, collect)
    end
    print("|cff39c5bbRaid Team Stats|r v" .. ADDON_VERSION .. " loaded. /rts export to copy a manual export, /rts help for commands.")
  elseif event == "PLAYER_LOGOUT" then
    -- Final refresh so the SavedVariables file the companion reads is current.
    collect()
  else
    -- UPDATE_INSTANCE_INFO = raid-lockout data has round-tripped; this is
    -- the readiness signal that gates a "complete" capture (it fires even
    -- when the player has zero lockouts).
    if event == "UPDATE_INSTANCE_INFO" then sawInstanceInfo = true end
    -- Vault/M+/gear/lockout/talent changed — refresh (debounced).
    C_Timer.After(2, collect)
  end
end)
