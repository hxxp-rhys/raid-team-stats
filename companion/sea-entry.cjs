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
  unlinkSync,
} = require("node:fs");
const { join, dirname } = require("node:path");
const { homedir } = require("node:os");
const { createHash, randomBytes } = require("node:crypto");
const { execFile, execFileSync } = require("node:child_process");
const http = require("node:http");

// Next to the exe when packaged; next to this file when run via node.
const HERE = process.execPath.toLowerCase().endsWith("node.exe")
  ? __dirname
  : dirname(process.execPath);

// bump in lockstep with installer/Package.wxs Version + src/lib/companion-release.ts LATEST_COMPANION_VERSION
const COMPANION_VERSION = "1.0.33.0";

// Hard ceiling on the addon bundle download. The real bundle is ~40 KB; this
// 8 MB cap bounds memory and refuses an absurd/hostile response before buffering.
const MAX_ADDON_BUNDLE_BYTES = 8 * 1024 * 1024;

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
  // On a one-shot run, make the fatal error visible so it no longer looks like
  // "nothing happened". The --watch watcher stays silent (interactive===false).
  if (interactive) {
    const notConfigured = /^No (instance URL|upload token|WoW path)\b/.test(m);
    if (notConfigured) {
      showBox(
        "Raid Team Stats isn't set up yet (no site address / upload token saved).\n\n" +
          "Re-run the installer to enter them, or edit config.json in " +
          "%LOCALAPPDATA%\\RaidTeamStats.",
        "Raid Team Stats",
      );
    } else {
      showBox(m, "Raid Team Stats");
    }
  }
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

// Interactive (one-shot) heuristic: the autostart background watcher passes
// --watch and MUST stay completely silent/windowless; a manual double-click or
// the "Upload Now" shortcut passes no --watch, so we give the user a visible
// result instead of "nothing happened".
const interactive = !process.argv.includes("--watch");

// Best-effort native message box via a hidden PowerShell. PowerShell is always
// present + trusted, so this is fine from a signed SEA. Wrapped so it can NEVER
// throw and NEVER block the caller (windowsHide keeps the watcher windowless,
// but we gate every call on `interactive` regardless).
function showBox(msg, title) {
  try {
    execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-WindowStyle",
        "Hidden",
        "-Command",
        "Add-Type -AssemblyName System.Windows.Forms;" +
          "[void][System.Windows.Forms.MessageBox]::Show(" +
          `${JSON.stringify(msg)},${JSON.stringify(title)})`,
      ],
      { windowsHide: true },
    );
  } catch {
    /* best-effort: a UI fault must never crash the uploader */
  }
}

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
  // Opt-in addon auto-update. STRICT: only the literal boolean `true` enables
  // it — any other value (missing, "true", 1, null) leaves it OFF.
  const autoUpdateAddon = cfg.autoUpdateAddon === true;
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
  return { api, token, wowPath, autoUpdateAddon };
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

// Merge `partial` into config.json and write it atomically (temp+rename,
// mirroring persistToken), preserving all other keys (api/token/wowPath/
// autoUpdateAddon). Best-effort: a failure here must never crash the caller.
// Used by the tray control server to persist toggles like autoUpdateAddon.
function patchConfig(partial) {
  try {
    const p = configPath();
    let cfg = {};
    try {
      cfg = JSON.parse(readFileSync(p, "utf8"));
    } catch {
      /* missing/corrupt — recreate from the merge */
    }
    const merged = { ...cfg, ...partial };
    const data = JSON.stringify(merged, null, 2) + "\n";
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, data);
    renameSync(tmp, p);
  } catch (e) {
    log(`warning: could not patch config: ${(e && e.message) || e}`);
  }
}

// ── Opt-in addon auto-update (Phase 3b-ii) ──────────────────────────────────
// SAFETY: this routine modifies files inside the user's WoW install, so every
// step is gated and integrity-checked, it is OFF by default, it touches ONLY
// the two StatSmith addon files (never WTF/SavedVariables), and the whole thing
// is wrapped so it can NEVER throw or affect the upload path. See the HARD
// SAFETY INVARIANTS in the project notes.
//
// The functions below (compareVersions, readInstalledAddonVersion,
// isWowRunning, maybeUpdateAddon) are kept BYTE-IDENTICAL between upload.mjs
// and sea-entry.cjs — do not let the two twins drift.

// Mirror of src/lib/companion-release.ts compareVersions: NUMERIC per-segment
// compare (so "1.0.22" > "1.0.9"), zero-padding the shorter. Returns -1/0/1.
function compareVersions(a, b) {
  const as = String(a).split(".");
  const bs = String(b).split(".");
  const len = Math.max(as.length, bs.length);
  for (let i = 0; i < len; i++) {
    const an = parseInt(as[i] ?? "0", 10) || 0;
    const bn = parseInt(bs[i] ?? "0", 10) || 0;
    if (an < bn) return -1;
    if (an > bn) return 1;
  }
  return 0;
}

// Read the installed addon's "## Version:" from its .toc. Returns the trimmed
// version string, or null if the file is missing/unreadable/has no version line.
function readInstalledAddonVersion(wowPath) {
  try {
    const toc = join(
      wowPath,
      "_retail_",
      "Interface",
      "AddOns",
      "StatSmith",
      "StatSmith.toc",
    );
    const text = readFileSync(toc, "utf8");
    const m = text.match(/^\s*##\s*Version:\s*(.+?)\s*$/m);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

// Is WoW running? FAIL-SAFE: on ANY error we resolve TRUE (assume running and
// therefore DON'T update) — we must never write into a live WoW install.
function isWowRunning() {
  return new Promise((resolve) => {
    try {
      execFile(
        "tasklist",
        ["/FI", "IMAGENAME eq Wow.exe", "/NH", "/FO", "CSV"],
        { timeout: 5000, windowsHide: true },
        (err, stdout) => {
          if (err) return resolve(true);
          try {
            resolve(String(stdout).toLowerCase().includes("wow.exe"));
          } catch {
            resolve(true);
          }
        },
      );
    } catch {
      resolve(true);
    }
  });
}

// Fetch a URL with a hard timeout; returns the Response or throws.
async function fetchWithTimeout(url, opts, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...(opts || {}), signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// Best-effort, opt-in addon updater. Wrapped so it can NEVER throw and NEVER
// touch the upload path. Aborts silently (logs + returns) at the first failed
// gate. See HARD SAFETY INVARIANTS.
async function maybeUpdateAddon(cfg) {
  let tmpBundle = null;
  try {
    // (a) Off by default — only runs when the user explicitly opted in.
    if (!cfg.autoUpdateAddon) return;

    // (b) Fetch the manifest (with a timeout). Require the addon fields.
    let manifest;
    try {
      const res = await fetchWithTimeout(
        `${cfg.api}/uploader/manifest`,
        { headers: { "X-RTS-Companion-Version": COMPANION_VERSION } },
        15000,
      );
      if (!res.ok) {
        log(`addon update: manifest HTTP ${res.status} — skipping`);
        return;
      }
      manifest = await res.json();
    } catch (e) {
      log(`addon update: manifest fetch failed: ${(e && e.message) || e}`);
      return;
    }
    const addon = manifest && manifest.addon;
    if (
      !addon ||
      typeof addon.latest !== "string" ||
      typeof addon.downloadUrl !== "string" ||
      typeof addon.minCompanionVersion !== "string"
    ) {
      log("addon update: manifest missing addon fields — skipping");
      return;
    }

    // (c) Compat gate: never auto-apply if this companion predates the floor
    // the manifest advertises for safe auto-apply.
    if (compareVersions(COMPANION_VERSION, addon.minCompanionVersion) < 0) {
      log(
        `addon update: companion ${COMPANION_VERSION} < required ` +
          `${addon.minCompanionVersion} — skipping`,
      );
      return;
    }

    // (d) Only update an addon that's actually installed AND out of date.
    const installed = readInstalledAddonVersion(cfg.wowPath);
    if (!installed) return; // not installed / unreadable — nothing to update
    if (compareVersions(installed, addon.latest) >= 0) return; // already current

    // (e) Never write into a live WoW install (checked again before write).
    if (await isWowRunning()) {
      log("addon update: WoW is running — skipping");
      return;
    }

    // (f) Download the bundle + its SHA-256 sidecar into a TEMP file under the
    // config dir (NOT the WoW folder). Verify the digest BEFORE touching WoW.
    let bundleBytes;
    let sidecarText;
    try {
      const bRes = await fetchWithTimeout(addon.downloadUrl, {}, 30000);
      if (!bRes.ok) {
        log(`addon update: bundle HTTP ${bRes.status} — skipping`);
        return;
      }
      const clen = Number(bRes.headers.get("content-length") || 0);
      if (clen > MAX_ADDON_BUNDLE_BYTES) {
        log(
          `addon update: bundle too large (Content-Length ${clen} > ` +
            `${MAX_ADDON_BUNDLE_BYTES}) — skipping`,
        );
        return;
      }
      bundleBytes = Buffer.from(await bRes.arrayBuffer());
      if (bundleBytes.length > MAX_ADDON_BUNDLE_BYTES) {
        log(
          `addon update: bundle too large (${bundleBytes.length} > ` +
            `${MAX_ADDON_BUNDLE_BYTES}) — skipping`,
        );
        return;
      }
      const sRes = await fetchWithTimeout(`${addon.downloadUrl}.sha256`, {}, 15000);
      if (!sRes.ok) {
        log(`addon update: sha256 HTTP ${sRes.status} — skipping`);
        return;
      }
      sidecarText = await sRes.text();
    } catch (e) {
      log(`addon update: download failed: ${(e && e.message) || e}`);
      return;
    }

    const cfgDir = join(
      process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"),
      "RaidTeamStats",
    );
    try {
      mkdirSync(cfgDir, { recursive: true });
    } catch {
      /* best-effort; write below will fail loudly into the catch */
    }
    tmpBundle = join(cfgDir, `addon-bundle.${process.pid}.tmp`);
    writeFileSync(tmpBundle, bundleBytes);

    // INTEGRITY: sha256 of the downloaded BYTES must match the sidecar digest
    // (first 64 hex chars). A mismatch means we NEVER touch the WoW folder.
    const actual = createHash("sha256").update(bundleBytes).digest("hex");
    const expected = String(sidecarText)
      .trim()
      .toLowerCase()
      .slice(0, 64);
    if (!/^[0-9a-f]{64}$/.test(expected) || actual !== expected) {
      log("addon update: SHA-256 mismatch — refusing to update");
      return; // finally{} deletes the temp bundle
    }

    // (g) Parse + STRUCTURALLY validate the bundle before extracting files.
    let bundle;
    try {
      bundle = JSON.parse(bundleBytes.toString("utf8"));
    } catch {
      log("addon update: bundle is not valid JSON — skipping");
      return;
    }
    if (!bundle || typeof bundle.version !== "string" || !bundle.version) {
      log("addon update: bundle has no version — skipping");
      return;
    }
    const files = bundle.files;
    if (!files || typeof files !== "object") {
      log("addon update: bundle has no files map — skipping");
      return;
    }
    const toc = files["StatSmith.toc"];
    const lua = files["StatSmith.lua"];
    if (typeof toc !== "string" || !toc || typeof lua !== "string" || !lua) {
      log("addon update: bundle missing StatSmith.toc/.lua — skipping");
      return;
    }
    if (!toc.includes("## Interface")) {
      log("addon update: bundle .toc is not a valid TOC — skipping");
      return;
    }

    // (h) TOCTOU guard: re-check WoW is closed immediately before writing.
    if (await isWowRunning()) {
      log("addon update: WoW started — aborting before write");
      return;
    }

    // (i) Write ONLY the two allow-listed files, each via temp+atomic rename
    // into the existing StatSmith folder. We overwrite in place (a crash never
    // leaves a half-written addon file) and never delete the good files first.
    const addonDir = join(
      cfg.wowPath,
      "_retail_",
      "Interface",
      "AddOns",
      "StatSmith",
    );
    const ALLOWED = ["StatSmith.toc", "StatSmith.lua"];
    for (const key of Object.keys(files)) {
      if (!ALLOWED.includes(key)) continue; // allowlist
      // Path-traversal guard: the key must be a plain basename.
      if (key.includes("/") || key.includes("\\") || key.includes("..")) {
        log(`addon update: refusing suspicious file name "${key}"`);
        return;
      }
      const content = files[key];
      if (typeof content !== "string" || !content) continue;
      const dest = join(addonDir, key);
      const tmp = `${dest}.${process.pid}.tmp`;
      writeFileSync(tmp, content, "utf8");
      renameSync(tmp, dest); // atomic replace
    }

    // (j) Done.
    log(`addon updated to v${addon.latest}`);
  } catch (e) {
    // The whole routine is best-effort: a failure here must NEVER crash the
    // companion or affect uploads.
    log(`addon update: unexpected error (ignored): ${(e && e.message) || e}`);
  } finally {
    if (tmpBundle) {
      try {
        unlinkSync(tmpBundle);
      } catch {
        /* best-effort cleanup */
      }
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

// Returns a short outcome tag for the one-shot result box:
//   "none"     no snapshot yet / partial capture (nothing to upload)
//   "uploaded" the server accepted a fresh upload
//   "skipped"  server had nothing new (already current)
//   "failed"   network/HTTP error
async function uploadOne(cfg, file) {
  const exp = extractExport(await readFile(file, "utf8"));
  if (!exp) {
    log(`skip (no snapshot yet): ${file}`);
    return "none";
  }
  if (captureIsPartial(exp)) {
    log(
      "skip (partial capture — stay logged into WoW ~5 min for a full " +
        `sync): ${file}`,
    );
    return "none";
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
        // Report our version so the site can flag out-of-date companions.
        "X-RTS-Companion-Version": COMPANION_VERSION,
      },
      body: exp,
    });
  } catch (e) {
    log(`network error: ${(e && e.message) || e}`);
    return "failed";
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
    return "skipped";
  } else if (res.ok && body.ok) {
    log(
      `uploaded ${body.character || "?"} — World vault ${
        (body.world && body.world.unlocked) ?? "?"
      }/${(body.world && body.world.total) ?? 3}, ${
        body.weeklyMplusRuns ?? "?"
      } M+ this week`,
    );
    return "uploaded";
  } else {
    log(
      `upload failed (${res.status}): ${body.error || bodyText.slice(0, 200)}`,
    );
    return "failed";
  }
}

// Aggregates the per-file outcomes into a single tag for the one-shot result
// box: "uploaded" if anything uploaded, else "failed" if anything failed, else
// "none" (no data / nothing new). One box per run — main() shows it.
async function runOnce(cfg) {
  const files = findSavedVarFiles(cfg.wowPath);
  if (files.length === 0) {
    log(
      "No Raid Team Stats SavedVariables found yet. In WoW: enable the Raid Team Stats " +
        "addon and log in — it writes its data file within ~60s.",
    );
    return "none";
  }
  let uploaded = false;
  let failed = false;
  for (const f of files) {
    const r = await uploadOne(cfg, f);
    if (r === "uploaded") uploaded = true;
    else if (r === "failed") failed = true;
  }
  if (uploaded) return "uploaded";
  if (failed) return "failed";
  return "none";
}

// ── --watch sync pass + tray control state ──────────────────────────────────
// Module-level so the periodic poll, the tray "Sync now", and GET /status all
// share one mtime debounce + one view of the last result. Kept BYTE-IDENTICAL
// between upload.mjs and sea-entry.cjs.

// Per-file mtime debounce for the --watch poll (avoid re-uploading an unchanged
// SavedVariables file every cycle). A forced sync (tray "Sync now") ignores it.
const seen = new Map();
// Last sync timestamp (ISO) + a short human-readable result, surfaced to the
// tray via GET /status. Null until the first --watch pass runs.
let lastSyncAt = null;
let lastResult = null;

// Run one upload pass over every SavedVariables file. When opts.force is set
// (tray "Sync now") the mtime `seen` debounce is IGNORED so even unchanged
// files re-upload; otherwise only mtime-changed files upload. Updates the
// module-level lastSyncAt/lastResult and returns { uploaded, skipped }.
async function syncNow(cfg, opts) {
  const force = !!(opts && opts.force);
  let uploaded = 0;
  let skipped = 0;
  try {
    for (const f of findSavedVarFiles(cfg.wowPath)) {
      let changed = true;
      try {
        const m = (await stat(f)).mtimeMs;
        if (!force && seen.get(f) === m) {
          changed = false;
        } else {
          seen.set(f, m);
        }
      } catch (e) {
        log(`sync: stat failed for ${f}: ${(e && e.message) || e}`);
        changed = force; // can't debounce; upload only if forced
      }
      if (changed) {
        await uploadOne(cfg, f);
        uploaded++;
      } else {
        skipped++;
      }
    }
    lastResult = `${uploaded} uploaded, ${skipped} skipped`;
  } catch (e) {
    lastResult = `error: ${(e && e.message) || e}`;
    log(`sync pass error: ${(e && e.message) || e}`);
  }
  lastSyncAt = new Date().toISOString();
  return { uploaded, skipped };
}

// ── Tray loopback control server (Phase 4) ──────────────────────────────────
// A separate signed tray exe controls this running --watch companion over
// loopback HTTP. SECURITY: binds ONLY 127.0.0.1 on an ephemeral port; every
// request must present the per-launch random secret; control.json (with the
// port + secret) is written into the ACL-protected %LOCALAPPDATA%\RaidTeamStats
// next to config.json + the token. Started ONLY in --watch mode (never one-shot).
// The whole thing is fail-safe: a bind/listen error logs + is ignored so the
// upload poll keeps working WITHOUT the tray, and the server can NEVER crash the
// upload path. Kept BYTE-IDENTICAL between upload.mjs and sea-entry.cjs.

// Per-launch random secret that gates EVERY control request.
const controlSecret = randomBytes(16).toString("hex");

function controlJsonPath() {
  const lad =
    process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
  return join(lad, "RaidTeamStats", "control.json");
}

// Constant-time-ish secret check: length gate, then compare. A mismatch (or a
// missing header) is a 403. Never reveals which part failed.
function controlAuthorized(req) {
  const got = req.headers["x-rts-control"];
  if (typeof got !== "string") return false;
  if (got.length !== controlSecret.length) return false;
  return got === controlSecret;
}

// Read a small JSON request body (capped at ~64KB) and JSON.parse it. Returns
// {} on empty/invalid body so a malformed request can never throw the handler.
function readControlBody(req) {
  return new Promise((resolve) => {
    const MAX = 64 * 1024;
    let buf = "";
    let aborted = false;
    req.on("data", (chunk) => {
      if (aborted) return;
      buf += chunk;
      if (buf.length > MAX) {
        aborted = true;
        buf = "";
        try {
          req.destroy();
        } catch {
          /* best-effort */
        }
        resolve({});
      }
    });
    req.on("end", () => {
      if (aborted) return;
      try {
        resolve(buf ? JSON.parse(buf) : {});
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

function sendJson(res, status, obj) {
  try {
    const data = JSON.stringify(obj);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(data);
  } catch {
    try {
      res.end();
    } catch {
      /* best-effort */
    }
  }
}

// Start the loopback control server for the tray. Returns the server (or null
// if it could not start). FAIL-SAFE: any bind/listen error is logged + ignored;
// the caller's upload poll continues without the tray.
function startControlServer(cfg, intervals) {
  try {
    const server = http.createServer((req, res) => {
      // Gate EVERY request on the per-launch secret first.
      if (!controlAuthorized(req)) {
        try {
          res.writeHead(403);
        } catch {
          /* best-effort */
        }
        try {
          res.end();
        } catch {
          /* best-effort */
        }
        return;
      }
      const method = req.method || "GET";
      const url = (req.url || "/").split("?")[0];
      // Drain/parse the body up front (capped) for every route; harmless on GET.
      readControlBody(req)
        .then(async (body) => {
          if (method === "GET" && url === "/status") {
            sendJson(res, 200, {
              ok: true,
              version: COMPANION_VERSION,
              autoUpdateAddon: cfg.autoUpdateAddon === true,
              lastSyncAt,
              lastResult,
            });
            return;
          }
          if (method === "POST" && url === "/sync") {
            const r = await syncNow(cfg, { force: true });
            sendJson(res, 200, {
              ok: true,
              uploaded: r.uploaded,
              skipped: r.skipped,
            });
            return;
          }
          if (method === "POST" && url === "/config") {
            if (typeof body.autoUpdateAddon === "boolean") {
              // LIVE in-memory update so maybeUpdateAddon sees it immediately,
              // plus persist it to config.json for the next launch.
              cfg.autoUpdateAddon = body.autoUpdateAddon;
              patchConfig({ autoUpdateAddon: body.autoUpdateAddon });
            }
            sendJson(res, 200, {
              ok: true,
              autoUpdateAddon: cfg.autoUpdateAddon === true,
            });
            return;
          }
          if (method === "POST" && url === "/quit") {
            sendJson(res, 200, { ok: true });
            try {
              for (const t of intervals || []) clearInterval(t);
            } catch {
              /* best-effort */
            }
            try {
              server.close();
            } catch {
              /* best-effort */
            }
            try {
              unlinkSync(controlJsonPath());
            } catch {
              /* best-effort */
            }
            process.exit(0);
            return;
          }
          sendJson(res, 404, { ok: false, error: "not found" });
        })
        .catch((e) => {
          sendJson(res, 500, {
            ok: false,
            error: (e && e.message) || String(e),
          });
        });
    });

    server.on("error", (e) => {
      // EADDRINUSE / EACCES / etc.: log + continue WITHOUT the tray. The upload
      // poll keeps working; the server must never crash the upload path.
      log(`control server error (tray disabled, uploads continue): ${
        (e && e.message) || e
      }`);
    });

    server.on("listening", () => {
      try {
        const addr = server.address();
        const port = addr && typeof addr === "object" ? addr.port : 0;
        const p = controlJsonPath();
        const data =
          JSON.stringify(
            {
              port,
              pid: process.pid,
              secret: controlSecret,
              version: COMPANION_VERSION,
            },
            null,
            2,
          ) + "\n";
        const tmp = `${p}.tmp`;
        writeFileSync(tmp, data);
        renameSync(tmp, p);
        log(`control server listening on 127.0.0.1:${port}`);
      } catch (e) {
        log(`control server: could not write control.json: ${
          (e && e.message) || e
        }`);
      }
    });

    // Bind to an ephemeral port on loopback ONLY.
    server.listen(0, "127.0.0.1");

    // Best-effort: drop control.json on process exit so a stale port/secret
    // never lingers for the tray to connect to.
    process.on("exit", () => {
      try {
        unlinkSync(controlJsonPath());
      } catch {
        /* best-effort */
      }
    });

    return server;
  } catch (e) {
    // Fail-safe: never let control-server setup take down the uploader.
    log(`control server: failed to start (tray disabled, uploads continue): ${
      (e && e.message) || e
    }`);
    return null;
  }
}

async function main() {
  const cfg = loadConfig();
  const watch = process.argv.includes("--watch");
  log(`api=${cfg.api}  wow=${cfg.wowPath}${watch ? "  (watch mode)" : ""}`);
  const result = await runOnce(cfg);
  if (!watch) {
    // One-shot run finished — give the user a single visible result box so a
    // manual double-click / "Upload Now" no longer looks like nothing happened.
    // (The --watch watcher never reaches here; it reports via the tray.)
    if (interactive) {
      if (result === "uploaded") {
        showBox("Uploaded your latest WoW data.", "Raid Team Stats");
      } else if (result === "failed") {
        showBox(
          "Couldn't upload right now. Check your connection and try again — " +
            "see the log in %LOCALAPPDATA%\\RaidTeamStats\\uploader.log for details.",
          "Raid Team Stats",
        );
      } else {
        showBox(
          "No new data to upload yet — log into WoW with the addon enabled, " +
            "then try again.",
          "Raid Team Stats",
        );
      }
    }
    return;
  }

  // Opt-in addon auto-update runs in --watch mode ONLY (never one-shot). It is
  // fire-and-forget (never awaited) so it can't block or delay upload polling,
  // and throttled to at most once per hour. maybeUpdateAddon itself can never
  // throw, but guard the kickoff too for belt-and-braces.
  const ADDON_CHECK_MS = 60 * 60 * 1000;
  let lastAddonCheck = 0;
  const checkAddon = () => {
    const now = Date.now();
    if (now - lastAddonCheck < ADDON_CHECK_MS) return;
    lastAddonCheck = now;
    maybeUpdateAddon(cfg).catch((e) =>
      log(`addon update: kickoff error (ignored): ${(e && e.message) || e}`),
    );
  };
  // First check shortly after startup (not blocking the initial upload).
  setTimeout(checkAddon, 30 * 1000);

  const POLL_MS = 5 * 60 * 1000;
  const pollTimer = setInterval(async () => {
    checkAddon();
    // Periodic pass keeps the existing mtime-changed debounce (force:false).
    await syncNow(cfg, { force: false });
  }, POLL_MS);
  log(`watching — re-checks every ${POLL_MS / 60000} min. Ctrl+C to stop.`);

  // Tray loopback control server (Phase 4): started ONLY in --watch mode, after
  // the timers are armed. Fail-safe — if it can't bind, uploads continue.
  startControlServer(cfg, [pollTimer]);
}

main().catch((e) => die((e && e.stack) || String(e)));
