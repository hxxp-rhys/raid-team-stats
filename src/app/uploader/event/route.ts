import { NextResponse } from "next/server";

import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { consumeLimit, policies } from "@/server/security/rate-limit";
import {
  resolveUploadTokenUserId,
  hashUploadToken,
} from "@/server/auth/upload-token";

/**
 * Companion install telemetry endpoint. The desktop uploader POSTs here on
 * install and uninstall so the site can show, per character on the roster
 * widget, whether the owning user actually has the companion running.
 *
 * Token-authenticated via `Authorization: Bearer <uploadToken>` (same
 * credential the ingest/verify endpoints use). The state lives in
 * CompanionStatus, one row per USER (the companion is a per-account desktop
 * app): every character of the same user therefore shows the same install
 * state; the roster widget joins via Character.userId.
 *
 * Deliberately NOT under /api/ (Cloudflare 404s new /api paths on this zone —
 * sibling of /uploader/ingest and /uploader/verify which work).
 *
 * Body JSON: { event: "install" | "uninstall", version?: string,
 * addonVersion?: string }. Best-effort with clear errors, mirroring the verify
 * route. GET returns 405.
 */

const MAX_BODY = 4 * 1024; // tiny payload — reject anything larger.

function bad(status: number, error: string) {
  return NextResponse.json({ ok: false, error }, { status });
}

export async function POST(req: Request) {
  // ── auth ──
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token || token.length < 16) return bad(401, "missing or invalid token");

  // Per-token cap (keyed by hash, not the raw secret).
  const rl = await consumeLimit(
    policies.uploadEventPerToken,
    hashUploadToken(token),
  );
  if (!rl.allowed) {
    return NextResponse.json(
      { ok: false, error: "rate limited" },
      {
        status: 429,
        headers: {
          "Retry-After": Math.max(
            1,
            Math.ceil((rl.resetAt - Date.now()) / 1000),
          ).toString(),
        },
      },
    );
  }

  const userId = await resolveUploadTokenUserId(token);
  if (!userId) return bad(401, "token not recognized");

  // ── body ──
  const raw = await req.text();
  if (raw.length > MAX_BODY) return bad(400, "oversized body");

  let parsed: { event?: unknown; version?: unknown; addonVersion?: unknown };
  try {
    parsed = JSON.parse(raw || "{}") as typeof parsed;
  } catch {
    return bad(400, "body is not valid JSON");
  }

  const event = parsed.event;
  if (event !== "install" && event !== "uninstall") {
    return bad(400, 'event must be "install" or "uninstall"');
  }
  const version =
    typeof parsed.version === "string" ? parsed.version.slice(0, 64) : null;
  const addonVersion =
    typeof parsed.addonVersion === "string"
      ? parsed.addonVersion.slice(0, 64)
      : null;

  const now = new Date();
  try {
    if (event === "install") {
      // Preserve the FIRST install timestamp: stamp installedAt only when the
      // row is new or had no prior install recorded.
      const existing = await db.companionStatus.findUnique({
        where: { userId },
        select: { installedAt: true },
      });
      await db.companionStatus.upsert({
        where: { userId },
        create: {
          userId,
          installed: true,
          installedAt: now,
          uninstalledAt: null,
          lastSeenVersion: version,
          lastSeenAddonVersion: addonVersion,
        },
        update: {
          installed: true,
          ...(existing?.installedAt == null ? { installedAt: now } : {}),
          uninstalledAt: null,
          lastSeenVersion: version,
          lastSeenAddonVersion: addonVersion,
        },
      });
    } else {
      await db.companionStatus.upsert({
        where: { userId },
        create: {
          userId,
          installed: false,
          uninstalledAt: now,
          lastSeenVersion: version,
          lastSeenAddonVersion: addonVersion,
        },
        update: {
          installed: false,
          uninstalledAt: now,
          ...(version != null ? { lastSeenVersion: version } : {}),
          ...(addonVersion != null
            ? { lastSeenAddonVersion: addonVersion }
            : {}),
        },
      });
    }
  } catch (err) {
    logger.error({ err, userId, event }, "companion event persist failed");
    return bad(500, "failed to record event");
  }

  return NextResponse.json({ ok: true });
}

// Reject non-POST explicitly so misconfigured clients get a clear error.
export function GET() {
  return bad(405, "POST { event } with Authorization: Bearer <token>");
}
