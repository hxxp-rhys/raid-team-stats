import { NextResponse } from "next/server";

import {
  LATEST_COMPANION_VERSION,
  LATEST_ADDON_VERSION,
} from "@/lib/companion-release";
import { DEFAULT_INSTALLER_URL } from "../installer/route";

/**
 * Public version manifest for the desktop companion. The companion polls this
 * to learn the latest published companion + addon versions and where to
 * download the installer, so it can show an in-app "update available" prompt.
 *
 * Public/unauthenticated — it discloses nothing but the latest published
 * version numbers and the central installer URL (same target as
 * /uploader/installer). Short-cached at the edge.
 *
 * Deliberately NOT under /api/ (Cloudflare 404s new /api paths on this zone —
 * sibling of /uploader/ingest and /uploader/verify which work).
 */

// Reuse the EXACT same installer source as /uploader/installer so the manifest
// and the redirect never drift.
const installerUrl =
  process.env.COMPANION_INSTALLER_URL || DEFAULT_INSTALLER_URL;

export async function GET() {
  return NextResponse.json(
    {
      ok: true,
      companion: { latest: LATEST_COMPANION_VERSION },
      addon: { latest: LATEST_ADDON_VERSION },
      installerUrl,
    },
    { headers: { "Cache-Control": "public, max-age=300" } },
  );
}
