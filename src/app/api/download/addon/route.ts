import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { buildStoreZip, type ZipEntry } from "@/lib/zip";
import { logger } from "@/lib/logger";

// Reads files from disk at request time — never prerender.
export const dynamic = "force-dynamic";

/**
 * One-click download bundling the in-game addon + the companion uploader
 * (zero-dependency STORE zip — no archiver dep). Public: the download
 * isn't sensitive; the per-user token is what secures uploads.
 */
const FILES: Array<{ src: string; zip: string }> = [
  {
    src: "addon/RaidTeamStatsUploader/RaidTeamStatsUploader.toc",
    zip: "RaidTeamStatsUploader/RaidTeamStatsUploader.toc",
  },
  {
    src: "addon/RaidTeamStatsUploader/RaidTeamStatsUploader.lua",
    zip: "RaidTeamStatsUploader/RaidTeamStatsUploader.lua",
  },
  { src: "companion/upload.mjs", zip: "companion/upload.mjs" },
  { src: "companion/README.md", zip: "companion/README.md" },
  {
    src: "companion/config.example.json",
    zip: "companion/config.example.json",
  },
];

const INSTALL_TXT = `Raid Team Stats — Uploader bundle
=================================

1) ADDON
   Copy the "RaidTeamStatsUploader" folder into:
     World of Warcraft\\_retail_\\Interface\\AddOns\\
   Enable it on the character screen (AddOns button), log in, then /reload.

2) COMPANION (sends the data — WoW addons can't use the internet)
   - Install Node.js 18+  (https://nodejs.org)
   - In the "companion" folder: copy config.example.json -> config.json
   - Put your upload token (from the website Account page) + WoW path in it
   - Run:  node upload.mjs --watch

Full details: companion/README.md
`;

export async function GET() {
  try {
    const entries: ZipEntry[] = [{ name: "INSTALL.txt", data: INSTALL_TXT }];
    for (const f of FILES) {
      const buf = await readFile(join(process.cwd(), f.src));
      entries.push({ name: f.zip, data: buf });
    }
    const zip = buildStoreZip(entries);
    return new Response(new Uint8Array(zip), {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition":
          'attachment; filename="raid-team-stats-uploader.zip"',
        "Content-Length": String(zip.length),
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    logger.error({ err }, "addon bundle download failed");
    return new Response("Failed to build download bundle", { status: 500 });
  }
}
