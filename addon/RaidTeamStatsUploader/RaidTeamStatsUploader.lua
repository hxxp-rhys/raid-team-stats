-- RaidTeamStatsUploader.lua  (WoW Midnight 12.0.5 — Interface 120005)
--
-- Reads the player's live data that has NO Blizzard web API (Great Vault
-- incl. the World/Delve row + per-row thresholds & reward previews, exact
-- M+ weekly runs, held keystone, weekly raid lockouts, equipped enchants,
-- catalyst charges & upgrade currencies, tier pieces sitting in bags, delve
-- progression, raid consumable readiness) plus gear/talents, and writes it
-- to SavedVariables. WoW addons cannot make network requests, so the
-- companion desktop uploader reads the saved file and POSTs it to
-- https://raiders.hxxp.io. A copy/paste export string is also provided as a
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
local SCHEMA_VERSION = 2
local ADDON_VERSION = "1.1.2"

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
          out.weeklyRuns[#out.weeklyRuns + 1] = {
            mapId = r.mapChallengeModeID,
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

-- Delve progression. The Delve season feeds the World Great Vault row
-- (already captured in `vault`). C_DelvesUI function names have moved
-- across 12.0.x, so probe defensively and store whatever this client
-- exposes — the server interprets it.
local function collectDelves()
  local out = {}
  if not C_DelvesUI then return out end
  out.api = {}
  -- Confirmed live 12.0.5 names (verified via /dump): the tier getter is
  -- GetActiveDelveTier (NOT GetCurrentDelveTier) and companion info is
  -- GetCompanionInfoForActivePlayer. Old names kept as fallbacks so the
  -- addon still works if Blizzard renames again.
  local getters = {
    "GetCurrentDelvesSeasonNumber",
    "GetDelvesSeasonNumber",
    "HasActiveDelve",
    "GetActiveDelveTier",
    "GetCurrentDelveTier",
    "GetDelveTier",
    "GetSeasonTierID",
    "GetDelveLevel",
    "GetHighestRunForCurrentSeason",
  }
  for _, fn in ipairs(getters) do
    if type(C_DelvesUI[fn]) == "function" then
      local ok, v = pcall(C_DelvesUI[fn])
      if ok and v ~= nil and type(v) ~= "table" then out.api[fn] = v end
    end
  end
  for _, fn in ipairs({
    "GetCompanionInfoForActivePlayer",
    "GetCompanionInfo",
  }) do
    if not out.companion and type(C_DelvesUI[fn]) == "function" then
      local ok, info = pcall(C_DelvesUI[fn])
      if ok and type(info) == "table" then
        -- Shape isn't documented; keep the raw table (server reads
        -- whatever field carries Brann's level) plus a best-guess.
        out.companion = info
        out.companion.level = info.level or info.experienceLevel
          or info.companionLevel or out.companion.level
      end
    end
  end
  return out
end

-- Weekly raid/dungeon lockouts incl. per-boss kill state THIS reset.
-- Blizzard's web API only exposes season aggregates, not the live
-- lockout. GetSavedInstanceInfo's signature is correct in 12.0, but the
-- saved-instance list (esp. numEncounters / per-boss state) is only
-- populated AFTER RequestRaidInfo() round-trips and UPDATE_INSTANCE_INFO
-- fires — without it numEncounters reads 0 and the boss list is empty.
-- The lifecycle code requests this on login and re-snapshots on
-- UPDATE_INSTANCE_INFO so the logout file the companion reads is whole;
-- the request here is a best-effort refresh.
local function collectLockouts()
  local out = {}
  pcall(RequestRaidInfo)
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

-- ─── assemble + persist ─────────────────────────────────────────────────
local function safe(fn, fallback)
  local ok, res = pcall(fn)
  if ok then return res end
  return fallback or {}
end

local function collect()
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
  local json = jsonEncode(payload)
  RaidTeamStatsUploaderDB = RaidTeamStatsUploaderDB or {}
  RaidTeamStatsUploaderDB.schema = SCHEMA_VERSION
  RaidTeamStatsUploaderDB.collectedAt = payload.collectedAt
  RaidTeamStatsUploaderDB.payload = payload      -- structured (debug/inspection)
  RaidTeamStatsUploaderDB.json = json            -- companion reads THIS string
  RaidTeamStatsUploaderDB.export = "RTS1:" .. base64(json) -- copy/paste fallback
  ns.lastJson = json
  return payload
end
ns.collect = collect

-- ─── export UI (copy/paste fallback) ────────────────────────────────────
local exportFrame
local function showExport()
  collect()
  if not exportFrame then
    local f = CreateFrame("Frame", "RTSUploaderExportFrame", UIParent, "BackdropTemplate")
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
  exportFrame.editBox:SetText(RaidTeamStatsUploaderDB.export or "")
  exportFrame.editBox:HighlightText()
  exportFrame.editBox:SetFocus()
  exportFrame:Show()
end

-- ─── slash command ──────────────────────────────────────────────────────
local PREFIX = "|cff39c5bbRaid Team Stats|r: "
local function printHelp()
  print(PREFIX .. "commands —")
  print("  /rts export  — collect a fresh snapshot and open the copy/paste export window")
  print("  /rts now     — collect a fresh snapshot silently (the companion app uploads it)")
  print("  /rts status  — show when the last snapshot was taken")
  print("  /rts help    — show this list")
end

SlashCmdList["RTSUPLOAD"] = function(msg)
  local cmd = strtrim(msg or ""):lower()
  if cmd == "now" then
    local p = collect()
    print(PREFIX .. "snapshot collected for " ..
      (p.character and p.character.name or "?") ..
      ". It uploads automatically; use /rts export to copy it manually.")
  elseif cmd == "status" then
    local at = RaidTeamStatsUploaderDB and RaidTeamStatsUploaderDB.collectedAt
    print(PREFIX .. "last snapshot " ..
      (at and date("%Y-%m-%d %H:%M", at) or "never") ..
      ". The companion app uploads the saved file.")
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
SLASH_RTSUPLOAD1 = "/rtsupload"
SLASH_RTSUPLOAD2 = "/rts"

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
ev:SetScript("OnEvent", function(self, event, arg1)
  if event == "ADDON_LOADED" and arg1 == AddonName then
    RaidTeamStatsUploaderDB = RaidTeamStatsUploaderDB or {}
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
    print("|cff39c5bbRaid Team Stats|r uploader loaded. /rts export to copy a manual export, /rts help for commands.")
  elseif event == "PLAYER_LOGOUT" then
    -- Final refresh so the SavedVariables file the companion reads is current.
    collect()
  else
    -- Vault/M+/gear changed — refresh (debounced).
    C_Timer.After(2, collect)
  end
end)
