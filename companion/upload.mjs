#!/usr/bin/env node
// Raid Team Stats — companion uploader
//
// WoW addons cannot make network requests, so this tiny zero-dependency
// Node script reads the RaidTeamStatsUploader addon's SavedVariables file
// and POSTs the captured snapshot to the website. Run it once, or with
// --watch to keep it uploading automatically while you play.
//
//   node upload.mjs            # one-shot upload
//   node upload.mjs --watch    # upload now, then re-check every 5 min
//
// Config: copy config.example.json -> config.json next to this file and
// fill it in (or set RTS_TOKEN / RTS_WOW_PATH / RTS_API env vars).
// Requires Node 18+ (built-in fetch). No npm install needed.

import { readFile, stat } from "node:fs/promises";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const die = (m) => {
  console.error(`[rts] ERROR: ${m}`);
  process.exit(1);
};
const log = (m) => console.log(`[rts] ${m}`);

function loadConfig() {
  let cfg = {};
  const cfgPath = join(HERE, "config.json");
  if (existsSync(cfgPath)) {
    try {
      cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    } catch {
      die(`config.json is not valid JSON: ${cfgPath}`);
    }
  }
  const api = (process.env.RTS_API || cfg.api || "https://raiders.hxxp.io")
    .trim()
    .replace(/\/+$/, "");
  const token = process.env.RTS_TOKEN || cfg.token || "";
  const wowPath = process.env.RTS_WOW_PATH || cfg.wowPath || "";
  // Hard requirement: your character data + token must never leave this
  // machine in plaintext. Refuse anything but HTTPS (TLS to Cloudflare,
  // then Cloudflare→origin is Full-strict TLS). No silent http downgrade.
  if (!/^https:\/\//i.test(api)) {
    die(
      `"api" must be https:// (got "${api}"). The uploader will not send ` +
        "your data over an unencrypted connection.",
    );
  }
  if (!token) die("No upload token. Set it in config.json or RTS_TOKEN.");
  if (!wowPath)
    die(
      'No WoW path. Set "wowPath" in config.json, e.g. ' +
        '"C:\\\\Program Files (x86)\\\\World of Warcraft"',
    );
  return { api, token, wowPath };
}

// One SavedVariables file per WoW account folder (retail).
function findSavedVarFiles(wowPath) {
  const found = [];
  const accountRoot = join(wowPath, "_retail_", "WTF", "Account");
  if (!existsSync(accountRoot)) return found;
  for (const acct of readdirSync(accountRoot)) {
    const f = join(
      accountRoot,
      acct,
      "SavedVariables",
      "RaidTeamStatsUploader.lua",
    );
    if (existsSync(f)) found.push(f);
  }
  return found;
}

// The file stores `["export"] = "RTS1:<base64>"`. Base64 has no characters
// Lua escapes, so a plain regex is robust (no Lua-string parser needed).
function extractExport(luaText) {
  const m = luaText.match(/\["export"\]\s*=\s*"(RTS1:[A-Za-z0-9+/=]+)"/);
  return m ? m[1] : null;
}

async function uploadOne(cfg, file) {
  const exp = extractExport(await readFile(file, "utf8"));
  if (!exp) {
    log(`skip (no snapshot yet): ${file}`);
    return;
  }
  let res;
  try {
    res = await fetch(`${cfg.api}/uploader/ingest`, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        Authorization: `Bearer ${cfg.token}`,
      },
      body: exp,
    });
  } catch (e) {
    log(`network error: ${e?.message ?? e}`);
    return;
  }
  const bodyText = await res.text();
  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    body = { raw: bodyText.slice(0, 200) };
  }
  if (res.ok && body.ok) {
    log(
      `uploaded ${body.character ?? "?"} — World vault ${
        body.world?.unlocked ?? "?"
      }/${body.world?.total ?? 3}, ${body.weeklyMplusRuns ?? "?"} M+ this week`,
    );
  } else {
    log(
      `upload failed (${res.status}): ${body.error ?? bodyText.slice(0, 200)}`,
    );
  }
}

async function runOnce(cfg) {
  const files = findSavedVarFiles(cfg.wowPath);
  if (files.length === 0) {
    log(
      "No RaidTeamStatsUploader SavedVariables found yet. Install the addon, " +
        "log in, then /reload or log out once so WoW writes the file.",
    );
    return;
  }
  for (const f of files) await uploadOne(cfg, f);
}

async function main() {
  const cfg = loadConfig();
  const watch = process.argv.includes("--watch");
  log(`api=${cfg.api}  wow=${cfg.wowPath}${watch ? "  (watch mode)" : ""}`);
  await runOnce(cfg);
  if (!watch) return;

  const POLL_MS = 5 * 60 * 1000;
  const seen = new Map();
  setInterval(async () => {
    try {
      for (const f of findSavedVarFiles(cfg.wowPath)) {
        const m = (await stat(f)).mtimeMs;
        if (seen.get(f) !== m) {
          seen.set(f, m);
          await uploadOne(cfg, f);
        }
      }
    } catch (e) {
      log(`watch cycle error: ${e?.message ?? e}`);
    }
  }, POLL_MS);
  log(`watching — re-checks every ${POLL_MS / 60000} min. Ctrl+C to stop.`);
}

main().catch((e) => die(e?.stack ?? String(e)));
