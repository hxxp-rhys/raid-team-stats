// Generates the addon auto-update bundle consumed by the companion (Phase 3b-ii).
//
// Reads the StatSmith addon's two SavedVariables-producing files (.toc + .lua),
// extracts the addon version from the .toc `## Version:` line, and writes a
// deterministic JSON bundle (sorted keys, no pretty-print) to argv[2]. Prints
// the bundle's SHA-256 hex to stdout so CI can publish a sidecar checksum.
//
// Dependency-free (node:fs / node:crypto / node:path) — runs unchanged on the
// Windows release runner. Does NOT touch the FROZEN wire contract: it only
// packages the addon files verbatim for the companion to verify + (gated) apply.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ADDON_DIR = join(__dirname, "..", "addon", "StatSmith");

const outPath = process.argv[2];
if (!outPath) {
  console.error(
    "usage: node scripts/build-addon-bundle.mjs <output.json>",
  );
  process.exit(1);
}

const tocText = readFileSync(join(ADDON_DIR, "StatSmith.toc"), "utf8");
const luaText = readFileSync(join(ADDON_DIR, "StatSmith.lua"), "utf8");

const versionMatch = tocText.match(/^##\s*Version:\s*(.+?)\s*$/m);
if (!versionMatch) {
  console.error("could not find '## Version:' line in StatSmith.toc");
  process.exit(1);
}
const version = versionMatch[1];

// Fixed key order (files keys sorted) so the bundle bytes — and therefore the
// SHA — are deterministic for identical inputs across runs/platforms.
const bundle = {
  version,
  files: {
    "StatSmith.lua": luaText,
    "StatSmith.toc": tocText,
  },
};

const json = JSON.stringify(bundle);
writeFileSync(outPath, json);

const sha = createHash("sha256").update(json).digest("hex");
console.log(sha);
