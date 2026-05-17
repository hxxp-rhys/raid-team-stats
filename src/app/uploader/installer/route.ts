import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { logger } from "@/lib/logger";

/**
 * Serves the prebuilt Windows MSI installer (bundles the companion runtime
 * + the addon; GUI for WoW folder / token / install location / autostart;
 * validates inputs before finishing). Built out-of-band by
 * installer/build.ps1 and placed at installer/dist/ on the host
 * (gitignored — it's a ~27 MB binary artifact). Not under /api/ (the
 * Cloudflare zone 404s new /api paths; /uploader/* works).
 */
const MSI_PATH = "installer/dist/raid-team-stats-uploader.msi";

export async function GET() {
  try {
    const abs = join(process.cwd(), MSI_PATH);
    await stat(abs); // 404 cleanly if the artifact isn't deployed
    const buf = await readFile(abs);
    return new Response(new Uint8Array(buf), {
      status: 200,
      headers: {
        "Content-Type": "application/x-msi",
        "Content-Disposition":
          'attachment; filename="raid-team-stats-uploader.msi"',
        "Content-Length": String(buf.length),
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    logger.warn({ err }, "MSI installer requested but artifact not present");
    return new Response(
      "Installer not available yet. Use the manual zip download for now.",
      { status: 404 },
    );
  }
}
