import { NextResponse } from "next/server";

/**
 * Windows companion installer (.msi) download.
 *
 * The installer is published CENTRALLY to the upstream project's GitHub
 * Releases by CI (.github/workflows/installer-release.yml) — it is NOT hosted
 * per-instance. This route 302-redirects to the latest release asset, so every
 * deployment shares one download and nobody has to self-host the ~28 MB binary.
 * (Until the first release is published — and while the repo is private —
 * GitHub returns 404 for that URL; that's expected, not an app bug.)
 *
 * The installer is instance-agnostic: the user enters their own site URL +
 * upload token during install, so the single central binary works for every
 * self-hosted instance. A fork that publishes its own installer can point this
 * elsewhere with the optional COMPANION_INSTALLER_URL env var.
 *
 * Not under /api/ (the Cloudflare zone 404s new /api paths; /uploader/* works).
 */
const DEFAULT_INSTALLER_URL =
  "https://github.com/hxxp-rhys/raid-stats/releases/latest/download/raid-team-stats-uploader.msi";

export function GET() {
  const url = process.env.COMPANION_INSTALLER_URL || DEFAULT_INSTALLER_URL;
  // 302 (not 301): the "latest" target moves every release, so the redirect
  // must not be cached permanently by browsers/CDNs.
  return NextResponse.redirect(url, 302);
}
