import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { logger } from "@/lib/logger";

/**
 * Serves the prebuilt Windows MSI installer (bundles the companion runtime
 * + the addon; GUI for WoW folder / token / install location / autostart;
 * validates inputs before finishing). Built out-of-band by
 * installer/build.ps1 and placed at installer/dist/ on the host
 * (gitignored — it's a ~28 MB binary artifact). Not under /api/ (the
 * Cloudflare zone 404s new /api paths; /uploader/* works).
 *
 * The download is named `Stat Smith Uploader <version>.msi`. The version
 * is read at request time from installer/Package.wxs (the single source
 * of truth the build uses) so the filename never drifts from the build.
 */
const MSI_PATH = "installer/dist/raid-team-stats-uploader.msi";
const PACKAGE_WXS = "installer/Package.wxs";

/** Package <Package Version="x.x.x.x">. Case-sensitive + 4-part so it
 *  never matches the lowercase `<?xml version="1.0"?>` declaration. */
async function readMsiVersion(): Promise<string | null> {
  try {
    const wxs = await readFile(join(process.cwd(), PACKAGE_WXS), "utf8");
    return /Version="(\d+\.\d+\.\d+\.\d+)"/.exec(wxs)?.[1] ?? null;
  } catch {
    return null;
  }
}

export async function GET() {
  try {
    const abs = join(process.cwd(), MSI_PATH);
    await stat(abs); // 404 cleanly if the artifact isn't deployed
    const [buf, ver] = await Promise.all([readFile(abs), readMsiVersion()]);

    const name = ver
      ? `Stat Smith Uploader ${ver}.msi`
      : "Stat Smith Uploader.msi";
    // Brand is fixed ASCII and `ver` is digits/dots only, so neither can
    // break the header. Provide the plain quoted filename plus the
    // RFC 5987 `filename*` (preferred by modern browsers).
    const disposition =
      `attachment; filename="${name}"; ` +
      `filename*=UTF-8''${encodeURIComponent(name)}`;

    return new Response(new Uint8Array(buf), {
      status: 200,
      headers: {
        "Content-Type": "application/x-msi",
        "Content-Disposition": disposition,
        "Content-Length": String(buf.length),
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    logger.warn({ err }, "MSI installer requested but artifact not present");
    return new Response("Installer not available yet — try again shortly.", {
      status: 404,
    });
  }
}
