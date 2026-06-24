import { NextResponse } from "next/server";

import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import {
  LATEST_COMPANION_VERSION,
  shouldNotify,
} from "@/lib/companion-release";
import { sendCompanionUpdateEmail } from "@/lib/email";
import { DEFAULT_INSTALLER_URL } from "../installer/route";
import { consumeLimit, policies } from "@/server/security/rate-limit";
import {
  resolveUploadTokenUserId,
  rotateUploadToken,
  hashUploadToken,
} from "@/server/auth/upload-token";
import {
  addonPayloadSchema,
  deriveVault,
  REGION_MAP,
  normalizeKey,
  type AddonPayload,
} from "@/server/ingestion/addon/payload";

/** Hard cap on observed sessions persisted per upload — bounds DB churn. */
const MAX_OBSERVED_SESSIONS = 20;

/**
 * Persist the addon's observed raid sessions (attendance_ledger feeder) to
 * RaidNightObservation. Best-effort: the observer's guild is resolved from
 * their active team membership; an observer not on a team has no attendance
 * home and is skipped. Each session UPSERTS by (observer, sessionId), so the
 * addon's repeated uploads of a growing night converge on its latest state.
 */
async function persistRaidObservations(
  observerCharacterId: string,
  userId: string,
  raidObserver: NonNullable<AddonPayload["raidObserver"]>,
): Promise<void> {
  const sessions = raidObserver.sessions ?? [];
  if (sessions.length === 0) return;
  const membership = await db.raidTeamMembership.findFirst({
    where: { characterId: observerCharacterId, isActive: true },
    select: { raidTeam: { select: { guildId: true } } },
  });
  const guildId = membership?.raidTeam.guildId;
  if (!guildId) return;

  for (const s of sessions.slice(0, MAX_OBSERVED_SESSIONS)) {
    const sessionId =
      s.sessionId != null
        ? String(s.sessionId)
        : s.startedAt != null
          ? String(s.startedAt)
          : null;
    const members = Array.isArray(s.members) ? s.members : [];
    // A session needs an id, a start, and at least one observed member.
    if (!sessionId || s.startedAt == null || members.length === 0) continue;
    const startedAt = new Date(s.startedAt * 1000);
    // Clamp end ≥ start: the addon stamps both from wall-clock time(), so a
    // backward clock correction mid-session could otherwise persist a
    // negative-length night.
    const endedAt = new Date(
      Math.max(s.endedAt ?? s.startedAt, s.startedAt) * 1000,
    );
    // Omit guildOnline when absent — a nullable Json column needs Prisma's
    // JsonNull sentinel to be set null, and "leave unchanged" is the right
    // update behaviour anyway.
    const data = {
      startedAt,
      endedAt,
      instanceName: s.instanceName ?? null,
      difficulty: s.difficulty ?? null,
      members: members as object,
      ...(Array.isArray(s.guildOnline)
        ? { guildOnline: s.guildOnline as object }
        : {}),
    };
    await db.raidNightObservation.upsert({
      where: { observerCharacterId_sessionId: { observerCharacterId, sessionId } },
      create: { guildId, observerCharacterId, uploadedByUserId: userId, sessionId, ...data },
      update: { ...data, capturedAt: new Date() },
    });
  }
}

/**
 * Ingest endpoint for our own in-game addon (via the companion uploader or
 * the website paste box). Token-authenticated — WoW addons can't make HTTP
 * requests, so the companion reads the addon's SavedVariables and POSTs the
 * captured JSON here with `Authorization: Bearer <uploadToken>`.
 *
 * Accepts either the raw JSON object/string, or the copy/paste export
 * (`RTS1:<base64-json>`). A user may only upload for THEIR OWN characters
 * (matched against the token owner's linked characters).
 */

const MAX_BODY = 512 * 1024; // 512 KB — payload is small; reject abuse.

function bad(status: number, error: string) {
  return NextResponse.json({ ok: false, error }, { status });
}

export async function POST(req: Request) {
  // ── auth ──
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token || token.length < 16) return bad(401, "missing or invalid token");

  // Per-token cap (keyed by hash, not the raw secret). Blunts a leaked
  // token / DB-write spam; well above the legit companion's cadence.
  const rl = await consumeLimit(
    policies.uploadIngestPerToken,
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
  if (!userId) return bad(401, "unauthorized");

  // Rolling token rotation is OPT-IN per request: only rotate for companions
  // that advertise they will persist the new token (`X-RTS-Rotate: 1`). Older
  // clients that can't persist would otherwise lock themselves out after the
  // one-use grace window, so for them we leave the token static.
  const wantsRotation = req.headers.get("x-rts-rotate") === "1";

  // Companion self-reported version (additive transport, NOT the frozen wire
  // contract): an optional request header. Trimmed + length-capped; null if
  // absent (paste-box uploads, older companions).
  const reportedCompanionVersion =
    req.headers.get("x-rts-companion-version")?.trim().slice(0, 64) || null;

  // ── body (JSON object, JSON string, or RTS1:<base64>) ──
  const raw = await req.text();
  if (!raw || raw.length > MAX_BODY) return bad(400, "empty or oversized body");

  let jsonText = raw.trim();
  if (jsonText.startsWith("RTS1:")) {
    try {
      jsonText = Buffer.from(jsonText.slice(5), "base64").toString("utf8");
    } catch {
      return bad(400, "malformed export string");
    }
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(jsonText);
  } catch {
    return bad(400, "body is not valid JSON");
  }

  const parsed = addonPayloadSchema.safeParse(parsedJson);
  if (!parsed.success) {
    logger.warn(
      {
        // path/code/message only — never the rejected value (user data).
        issues: parsed.error.issues.slice(0, 8).map((i) => ({
          path: i.path.join("."),
          code: i.code,
          message: i.message,
        })),
      },
      "addon ingest rejected (422): payload schema mismatch",
    );
    return bad(422, "payload did not match the expected addon schema");
  }
  const payload = parsed.data;

  // ── mark the companion installed + record its version ──
  // ANY authenticated upload that carries the version header (complete OR
  // partial) is proof the companion is installed and running, so we set
  // installed=true here — BEFORE the partial-capture early-return below.
  // This heals two gaps: (1) a row previously flipped to installed=false by an
  // "uninstall" event during a companion UPGRADE (the /uploader/event route)
  // was never restored, because the old code only set installed=true in the
  // upsert CREATE branch — so an actively-uploading companion showed as "not
  // installed" on the roster forever; (2) a companion that only ever sends
  // partial captures never reached the (post-early-return) status block at all.
  // Data persistence stays gated on `complete` further down — only the
  // install-presence flag is updated here. Paste-box / older companions omit
  // the header, so they're never falsely marked installed. Best-effort: a
  // failure here must not fail the upload.
  if (reportedCompanionVersion) {
    try {
      const existing = await db.companionStatus.findUnique({
        where: { userId },
        select: { installedAt: true },
      });
      const seen = {
        installed: true,
        uninstalledAt: null,
        lastSeenVersion: reportedCompanionVersion,
        ...(payload.addonVersion
          ? { lastSeenAddonVersion: payload.addonVersion }
          : {}),
      };
      await db.companionStatus.upsert({
        where: { userId },
        create: { userId, installedAt: new Date(), ...seen },
        // Preserve the FIRST install timestamp (mirrors /uploader/event); only
        // stamp installedAt when it was never set.
        update: {
          ...seen,
          ...(existing?.installedAt == null ? { installedAt: new Date() } : {}),
        },
      });
    } catch (err) {
      logger.warn({ err, userId }, "companion install-presence update failed");
    }
  }

  // ── reject partial captures ──
  // addon ≥1.1.5 sets complete=false for early/short-session snapshots
  // whose round-trip-dependent fields (keystone, lockout bosses, delves,
  // talents) aren't populated. Storing one would clobber a prior GOOD
  // capture, so we acknowledge (200, so the companion doesn't error-loop)
  // but DON'T persist. Absent (older addons) is treated as allowed.
  if (payload.complete === false) {
    return NextResponse.json({
      ok: true,
      skipped: "partial capture — stay logged in ~5 min for a full sync",
      ...(wantsRotation ? { nextToken: await rotateUploadToken(userId) } : {}),
    });
  }

  // ── resolve the caller's own character ──
  const region = REGION_MAP[payload.character.region.toLowerCase()];
  if (!region) {
    return bad(400, `unsupported region "${payload.character.region}"`);
  }
  const wantRealm = normalizeKey(payload.character.realm);
  const wantName = normalizeKey(payload.character.name);

  const candidates = await db.character.findMany({
    where: { userId: userId, region },
    select: { id: true, name: true, realmSlug: true },
  });
  const character = candidates.find(
    (c) =>
      normalizeKey(c.name) === wantName &&
      normalizeKey(c.realmSlug) === wantRealm,
  );
  if (!character) {
    return bad(
      404,
      "character not found among your linked characters — link/track it on the site first",
    );
  }

  // ── derive + persist ──
  const v = deriveVault(payload);
  const collectedAt = new Date(payload.collectedAt * 1000);

  // Equipped item level the addon read straight from the live client. `gear`
  // is z.unknown() in the schema, so dig it out defensively: only a finite
  // number, rounded to an int, is kept — anything else (absent/NaN/string)
  // → null. Stored as the addon-primary source for the displayed iLvL; the
  // Blizzard API iLvL remains the fallback (see snapshot.latestForTeam).
  const gearObj =
    payload.gear && typeof payload.gear === "object"
      ? (payload.gear as { equippedItemLevel?: unknown })
      : null;
  const rawIlvl = gearObj?.equippedItemLevel;
  const addonItemLevel =
    typeof rawIlvl === "number" && Number.isFinite(rawIlvl)
      ? Math.round(rawIlvl)
      : null;

  try {
    await db.addonUpload.upsert({
      where: { characterId: character.id },
      create: {
        characterId: character.id,
        userId: userId,
        collectedAt,
        addonVersion: payload.addonVersion ?? null,
        raidUnlocked: v.raidUnlocked,
        mplusUnlocked: v.mplusUnlocked,
        worldUnlocked: v.worldUnlocked,
        worldTotal: v.worldTotal,
        weeklyMplusRuns: v.weeklyMplusRuns,
        addonItemLevel,
        payload: payload as object,
      },
      update: {
        userId: userId,
        collectedAt,
        receivedAt: new Date(),
        addonVersion: payload.addonVersion ?? null,
        raidUnlocked: v.raidUnlocked,
        mplusUnlocked: v.mplusUnlocked,
        worldUnlocked: v.worldUnlocked,
        worldTotal: v.worldTotal,
        weeklyMplusRuns: v.weeklyMplusRuns,
        addonItemLevel,
        payload: payload as object,
      },
    });
  } catch (err) {
    logger.error({ err, characterId: character.id }, "addon upload persist failed");
    return bad(500, "failed to store upload");
  }

  // Observed raid presence (attendance_ledger) — separate store, best-effort:
  // a failure here must never fail the gear/vault upload above.
  if (payload.raidObserver) {
    try {
      await persistRaidObservations(character.id, userId, payload.raidObserver);
    } catch (err) {
      logger.warn(
        { err, characterId: character.id },
        "addon raidObserver persist failed",
      );
    }
  }

  // Companion "update available" notification (best-effort): if the user's
  // last-seen companion is behind the latest release and we haven't already
  // emailed them about THIS version, send a one-time nudge. Race-safe: we claim
  // the notified-version slot with a conditional updateMany BEFORE sending, so
  // concurrent uploads can't double-send. A failure here must never fail the
  // upload above. NOT placed before the partial-capture early return — only a
  // full, successful upload should trigger it.
  try {
    // The companion's install-presence + version were already recorded above
    // (for ANY versioned upload, before the partial-capture return). Here we
    // only decide whether to send the one-time "update available" email, using
    // that up-to-date state.
    const status = await db.companionStatus.findUnique({
      where: { userId },
      select: { lastSeenVersion: true, notifiedUpdateVersion: true },
    });
    if (status && shouldNotify(status, LATEST_COMPANION_VERSION)) {
      // Claim FIRST (conditional on not already claimed for this version). If
      // another concurrent request already claimed it, count === 0 → skip.
      const claim = await db.companionStatus.updateMany({
        where: { userId, NOT: { notifiedUpdateVersion: LATEST_COMPANION_VERSION } },
        data: { notifiedUpdateVersion: LATEST_COMPANION_VERSION },
      });
      if (claim.count > 0) {
        // email is auto-decrypted by the db extension.
        const user = await db.user.findUnique({
          where: { id: userId },
          select: { email: true, emailVerified: true },
        });
        // No email or unverified → skip the send. Match the reminder-sweep
        // stance: the claim STAYS (send is best-effort), so we don't retry
        // forever on an unreachable address.
        if (user?.email && user.emailVerified) {
          await sendCompanionUpdateEmail({
            to: user.email,
            currentVersion: status.lastSeenVersion ?? "(unknown)",
            latestVersion: LATEST_COMPANION_VERSION,
            installerUrl:
              process.env.COMPANION_INSTALLER_URL || DEFAULT_INSTALLER_URL,
          });
        }
      }
    }
  } catch (err) {
    logger.warn({ err, userId }, "companion update-notify failed");
  }

  return NextResponse.json({
    ok: true,
    character: character.name,
    world: { unlocked: v.worldUnlocked, total: v.worldTotal },
    weeklyMplusRuns: v.weeklyMplusRuns,
    ...(wantsRotation ? { nextToken: await rotateUploadToken(userId) } : {}),
  });
}

// Reject non-POST explicitly so misconfigured clients get a clear error.
export function GET() {
  return bad(405, "POST the addon JSON with Authorization: Bearer <token>");
}
