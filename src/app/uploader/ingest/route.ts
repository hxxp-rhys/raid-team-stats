import { NextResponse } from "next/server";

import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { consumeLimit, policies } from "@/server/security/rate-limit";
import {
  resolveUploadTokenUserId,
  hashUploadToken,
} from "@/server/auth/upload-token";
import {
  addonPayloadSchema,
  deriveVault,
  REGION_MAP,
  normalizeKey,
} from "@/server/ingestion/addon/payload";

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
        payload: payload as object,
      },
    });
  } catch (err) {
    logger.error({ err, characterId: character.id }, "addon upload persist failed");
    return bad(500, "failed to store upload");
  }

  return NextResponse.json({
    ok: true,
    character: character.name,
    world: { unlocked: v.worldUnlocked, total: v.worldTotal },
    weeklyMplusRuns: v.weeklyMplusRuns,
  });
}

// Reject non-POST explicitly so misconfigured clients get a clear error.
export function GET() {
  return bad(405, "POST the addon JSON with Authorization: Bearer <token>");
}
