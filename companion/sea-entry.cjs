// CommonJS entry for the single-executable build (Node SEA runs main as
// CJS). Functionally identical to upload.mjs. Built into rts-companion.exe
// by build-companion-exe.ps1 so end users need nothing installed.
//
//   rts-companion.exe            one-shot upload
//   rts-companion.exe --watch    upload now, re-check every 5 min
//
// Config: config.json next to the exe (or RTS_TOKEN/RTS_WOW_PATH/RTS_API
// env). The MSI installer writes config.json for the user.

"use strict";
const { readFile, stat } = require("node:fs/promises");
const {
  readFileSync,
  readdirSync,
  existsSync,
  appendFileSync,
  mkdirSync,
  statSync,
  writeFileSync,
  renameSync,
} = require("node:fs");
const { join, dirname } = require("node:path");
const { homedir } = require("node:os");

// Next to the exe when packaged; next to this file when run via node.
const HERE = process.execPath.toLowerCase().endsWith("node.exe")
  ? __dirname
  : dirname(process.execPath);

// The exe is built as a Windows GUI-subsystem binary (no console), so
// status goes to a rotating log next to the per-user config. Every
// call is best-effort and never throws — a logging fault must not take
// down the background uploader.
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
    /* logging is best-effort */
  }
}
const die = (m) => {
  try {
    console.error(`[rts] ERROR: ${m}`);
  } catch {
    /* no console under GUI subsystem */
  }
  writeLog(`ERROR: ${m}`);
  process.exit(1);
};
const log = (m) => {
  try {
    console.log(`[rts] ${m}`);
  } catch {
    /* no console under GUI subsystem */
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
  return primary; // used only for the "not found" error message
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
  if (!api) {
    die(
      'No instance URL. Set "api" in config.json to your Raid Stats site ' +
        '(e.g. https://raid.example.com), or pass RTS_API.',
    );
  }
  if (!/^https:\/\//i.test(api)) {
    die(
      `"api" must be https:// (got "${api}"). The uploader will not send ` +
        "your data over an unencrypted connection.",
    );
  }
  if (!token) die("No upload token. Set it in config.json or RTS_TOKEN.");
  if (!wowPath)
    die('No WoW path. Set "wowPath" in config.json.');
  return { api, token, wowPath };
}

// Persist a rotated upload token back to config.json (atomic temp+rename, with
// a non-atomic fallback), preserving the other keys.
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
      log(`warning: could not save rotated token: ${(e && e.message) || e}`);
    }
  }
}

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

function extractExport(luaText) {
  const m = luaText.match(/\["export"\]\s*=\s*"(RTS1:[A-Za-z0-9+/=]+)"/);
  return m ? m[1] : null;
}

// addon >=1.1.5 sets complete=false for early/short-session captures
// whose round-trip-dependent fields aren't populated; don't upload those
// (they'd clobber a prior good capture). Older addons omit it -> allowed.
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
    log(`network error: ${(e && e.message) || e}`);
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
      `uploaded ${body.character || "?"} — World vault ${
        (body.world && body.world.unlocked) ?? "?"
      }/${(body.world && body.world.total) ?? 3}, ${
        body.weeklyMplusRuns ?? "?"
      } M+ this week`,
    );
  } else {
    log(
      `upload failed (${res.status}): ${body.error || bodyText.slice(0, 200)}`,
    );
  }
}

async function runOnce(cfg) {
  const files = findSavedVarFiles(cfg.wowPath);
  if (files.length === 0) {
    log(
      "No Raid Team Stats SavedVariables found yet. In WoW: enable the Raid Team Stats " +
        "addon and log in — it writes its data file within ~60s.",
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
      log(`watch cycle error: ${(e && e.message) || e}`);
    }
  }, POLL_MS);
  log(`watching — re-checks every ${POLL_MS / 60000} min. Ctrl+C to stop.`);
}

main().catch((e) => die((e && e.stack) || String(e)));
