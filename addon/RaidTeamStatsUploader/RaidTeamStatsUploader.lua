-- RaidTeamStatsUploader.lua  (WoW Midnight 12.0 — Interface 120001)
--
-- Reads the player's live data that has NO Blizzard web API (Great Vault
-- incl. the World/Delve row, exact M+ weekly runs, equipped enchants) plus
-- gear/talents, and writes it to SavedVariables. WoW addons cannot make
-- network requests, so the companion desktop uploader reads the saved file
-- and POSTs it to https://raiders.hxxp.io. A copy/paste export string is
-- also provided as a no-companion fallback.
--
-- Every collector is pcall-guarded: one failing/renamed Blizzard API never
-- aborts the rest of the snapshot.

local AddonName, ns = ...

local SCHEMA_VERSION = 1
local ADDON_VERSION = "1.0.0"

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

local function collectIdentity()
  local name = UnitName("player")
  local realm = GetNormalizedRealmName() or GetRealmName()
  local _, classFile = UnitClass("player")
  local regionId = (GetCurrentRegion and GetCurrentRegion()) or 0
  local specName
  do
    local idx = GetSpecialization and GetSpecialization()
    if idx then
      specName = select(2, GetSpecializationInfo(idx))
    end
  end
  return {
    name = name,
    realm = realm,
    region = REGION_CODE[regionId] or tostring(regionId),
    class = classFile,
    spec = specName,
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
      out.activities[#out.activities + 1] = {
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
    end
  end
  return out
end

-- Exact M+ runs THIS reset (repeats included) — Blizzard's web API only
-- exposes the deduped best-per-dungeon, so this is the authoritative count.
local function collectMythicPlus()
  local out = { weeklyRuns = {}, season = nil }
  if C_MythicPlus then
    pcall(function() C_MythicPlus.RequestRewards() end)
    if C_MythicPlus.GetCurrentSeason then out.season = C_MythicPlus.GetCurrentSeason() end
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

local function collectTalents()
  local out = {}
  if C_ClassTalents and C_ClassTalents.GetActiveConfigID then
    out.configId = C_ClassTalents.GetActiveConfigID()
    if out.configId and C_Traits and C_Traits.GenerateImportString then
      local ok, str = pcall(C_Traits.GenerateImportString, out.configId)
      if ok then out.importString = str end
    end
  end
  return out
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
SlashCmdList["RTSUPLOAD"] = function(msg)
  local cmd = strtrim(msg or ""):lower()
  if cmd == "now" then
    local p = collect()
    print("|cff39c5bbRaid Team Stats|r: snapshot collected for " ..
      (p.character and p.character.name or "?") .. ". It uploads automatically; or /rtsupload show to copy it.")
  elseif cmd == "status" then
    local at = RaidTeamStatsUploaderDB and RaidTeamStatsUploaderDB.collectedAt
    print("|cff39c5bbRaid Team Stats|r: last snapshot " ..
      (at and date("%Y-%m-%d %H:%M", at) or "never") ..
      ". The companion app uploads the saved file.")
  else
    showExport()
  end
end
SLASH_RTSUPLOAD1 = "/rtsupload"
SLASH_RTSUPLOAD2 = "/rts"

-- ─── lifecycle ──────────────────────────────────────────────────────────
local ev = CreateFrame("Frame")
ev:RegisterEvent("ADDON_LOADED")
ev:RegisterEvent("PLAYER_LOGIN")
ev:RegisterEvent("PLAYER_LOGOUT")
ev:RegisterEvent("WEEKLY_REWARDS_UPDATE")
ev:RegisterEvent("CHALLENGE_MODE_COMPLETED")
ev:RegisterEvent("PLAYER_EQUIPMENT_CHANGED")
ev:SetScript("OnEvent", function(self, event, arg1)
  if event == "ADDON_LOADED" and arg1 == AddonName then
    RaidTeamStatsUploaderDB = RaidTeamStatsUploaderDB or {}
    self:UnregisterEvent("ADDON_LOADED")
  elseif event == "PLAYER_LOGIN" then
    -- Ask the client to populate vault / M+ data, then snapshot shortly after.
    pcall(function() C_MythicPlus.RequestRewards() end)
    pcall(function() C_WeeklyRewards.CanClaimRewards() end)
    C_Timer.After(8, collect)
    print("|cff39c5bbRaid Team Stats|r uploader loaded. /rtsupload to copy a manual export.")
  elseif event == "PLAYER_LOGOUT" then
    -- Final refresh so the SavedVariables file the companion reads is current.
    collect()
  else
    -- Vault/M+/gear changed — refresh (debounced).
    C_Timer.After(2, collect)
  end
end)
