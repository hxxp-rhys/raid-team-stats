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
  unlinkSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));

// bump in lockstep with installer/Package.wxs Version + src/lib/companion-release.ts LATEST_COMPANION_VERSION
const COMPANION_VERSION = "1.0.24.0";

// Hard ceiling on the addon bundle download. The real bundle is ~40 KB; this
// 8 MB cap bounds memory and refuses an absurd/hostile response before buffering.
const MAX_ADDON_BUNDLE_BYTES = 8 * 1024 * 1024;

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
  // Opt-in addon auto-update. STRICT: only the literal boolean `true` enables
  // it — any other value (missing, "true", 1, null) leaves it OFF.
  const autoUpdateAddon = cfg.autoUpdateAddon === true;
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
  return { api, token, wowPath, autoUpdateAddon };
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
        // Report our version so the site can flag out-of-date companions.
        "X-RTS-Companion-Version": COMPANION_VERSION,
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
      log(`addon update: kickoff error (ignored): ${e?.message ?? e}`),
    );
  };
  // First check shortly after startup (not blocking the initial upload).
  setTimeout(checkAddon, 30 * 1000);

  const POLL_MS = 5 * 60 * 1000;
  const seen = new Map();
  setInterval(async () => {
    checkAddon();
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
