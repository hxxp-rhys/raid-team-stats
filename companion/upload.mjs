#!/usr/bin/env node
// Raid Team Stats — companion uploader
//
// WoW addons cannot make network requests, so this tiny zero-dependency
// Node script reads the Raid Team Stats addon's SavedVariables file
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
import {
  readFileSync,
  readdirSync,
  existsSync,
  appendFileSync,
  mkdirSync,
  statSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));

// Mirrors sea-entry.cjs: best-effort rotating log next to the per-user
// config (the packaged exe is windowless / GUI-subsystem).
const LOG_DIR = join(
  process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"),
  "RaidTeamStats",
);
const LOG_FILE = join(LOG_DIR, "uploader.log");
function writeLog(line) {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    try {
      if (statSync(LOG_FILE).size > 262144) writeFileSync(LOG_FILE, "");
    } catch {
      /* no log yet */
    }
    appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    /* best-effort */
  }
}
const die = (m) => {
  try {
    console.error(`[rts] ERROR: ${m}`);
  } catch {
    /* no console */
  }
  writeLog(`ERROR: ${m}`);
  process.exit(1);
};
const log = (m) => {
  try {
    console.log(`[rts] ${m}`);
  } catch {
    /* no console */
  }
  writeLog(m);
};

// SECURITY (H3b): config + token live in the per-user, non-world-
// readable %LOCALAPPDATA%\RaidTeamStats. Fall back to the legacy
// next-to-exe path for installs that predate the relocation.
function configPath() {
  const lad =
    process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
  const primary = join(lad, "RaidTeamStats", "config.json");
  if (existsSync(primary)) return primary;
  const legacy = join(HERE, "config.json");
  if (existsSync(legacy)) return legacy;
  return primary;
}

function loadConfig() {
  let cfg = {};
  const cfgPath = configPath();
  if (existsSync(cfgPath)) {
    try {
      cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    } catch {
      die(`config.json is not valid JSON: ${cfgPath}`);
    }
  }
  const api = (process.env.RTS_API || cfg.api || "")
    .trim()
    .replace(/\/+$/, "");
  const token = process.env.RTS_TOKEN || cfg.token || "";
  const wowPath = process.env.RTS_WOW_PATH || cfg.wowPath || "";
  // This is a self-hostable app — the companion talks to YOUR Raid Stats
  // instance, so there is no canonical default. Set it in config.json (or
  // RTS_API). The installer writes this from the URL you enter during setup.
  if (!api) {
    die(
      'No instance URL. Set "api" in config.json to your Raid Stats site ' +
        '(e.g. https://raid.example.com), or pass RTS_API.',
    );
  }
  // Hard requirement: your character data + token must never leave this
  // machine in plaintext. Refuse anything but HTTPS. No silent http downgrade.
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

// Persist a rotated upload token back to config.json (atomic temp+rename, with
// a non-atomic fallback), preserving the other keys. The server hands us a new
// token on each accepted upload; saving it means a leaked token is invalidated
// by your normal use within ~one upload cycle.
function persistToken(newToken) {
  const p = configPath();
  let cfg = {};
  try {
    cfg = JSON.parse(readFileSync(p, "utf8"));
  } catch {
    /* missing/corrupt — recreate */
  }
  cfg.token = newToken;
  const data = JSON.stringify(cfg, null, 2) + "\n";
  try {
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, data);
    renameSync(tmp, p);
  } catch {
    try {
      writeFileSync(p, data);
    } catch (e) {
      log(`warning: could not save rotated token: ${e?.message ?? e}`);
    }
  }
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
      "StatSmith.lua",
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

// Decode RTS1:<base64> back to the payload and report whether it's a
// PARTIAL capture. addon >=1.1.5 sets complete=false for early/short
// sessions whose round-trip-dependent fields aren't populated yet; we
// don't upload those (they'd clobber a prior good capture server-side).
// Older addons omit the flag -> not partial (let the server decide).
function captureIsPartial(exp) {
  try {
    const json = Buffer.from(exp.slice(5), "base64").toString("utf8");
    return JSON.parse(json).complete === false;
  } catch {
    return false;
  }
}

async function uploadOne(cfg, file) {
  const exp = extractExport(await readFile(file, "utf8"));
  if (!exp) {
    log(`skip (no snapshot yet): ${file}`);
    return;
  }
  if (captureIsPartial(exp)) {
    log(
      "skip (partial capture — stay logged into WoW ~5 min for a full " +
        `sync): ${file}`,
    );
    return;
  }
  let res;
  try {
    res = await fetch(`${cfg.api}/uploader/ingest`, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        Authorization: `Bearer ${cfg.token}`,
        // Opt in to rolling token rotation: we persist the next token below.
        "X-RTS-Rotate": "1",
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
  // Rolling token rotation: adopt + persist the next token the server issued.
  if (
    res.ok &&
    body.ok &&
    typeof body.nextToken === "string" &&
    body.nextToken.length >= 16 &&
    body.nextToken !== cfg.token
  ) {
    cfg.token = body.nextToken;
    persistToken(body.nextToken);
  }
  if (res.ok && body.ok && body.skipped) {
    log(`skipped: ${body.skipped}`);
  } else if (res.ok && body.ok) {
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
      "No Raid Team Stats SavedVariables found yet. Install the Raid Team Stats addon, " +
        "enable it, and log in — it writes its data file within ~60s.",
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
