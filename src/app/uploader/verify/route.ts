import { NextResponse } from "next/server";

import { db } from "@/lib/db";
import { consumeLimit, policies } from "@/server/security/rate-limit";
import {
  resolveUploadTokenUserId,
  hashUploadToken,
} from "@/server/auth/upload-token";

/**
 * Lightweight token-validation endpoint for the MSI installer. Given an
 * upload token it confirms validity and returns ONLY a linked-character
 * count so the installer can show "Verified — N characters". It never
 * discloses the account email or the character list (a leaked token must
 * not be an email/roster oracle), is per-token rate-limited, and matches
 * on the hashed token (lazily migrating a legacy plaintext row).
 *
 * Deliberately NOT under /api/ (Cloudflare 404s new /api paths on this
 * zone — sibling of /uploader/ingest which works).
 *
 * Accepts the token via `Authorization: Bearer <t>` (preferred) or a
 * JSON/form body `{ "token": "..." }`. GET and POST both allowed so a
 * simple installer custom action can use either.
 */

function bad(status: number, error: string) {
  return NextResponse.json({ ok: false, error }, { status });
}

async function tokenFrom(req: Request): Promise<string> {
  const auth = req.headers.get("authorization") ?? "";
  if (auth.startsWith("Bearer ")) return auth.slice(7).trim();
  if (req.method === "POST") {
    try {
      const ct = req.headers.get("content-type") ?? "";
      if (ct.includes("application/json")) {
        const j = (await req.json()) as { token?: unknown };
        if (typeof j.token === "string") return j.token.trim();
      } else {
        const t = (await req.text()).trim();
        if (t) return t.replace(/^token=/, "");
      }
    } catch {
      /* fall through */
    }
  }
  return "";
}

async function handle(req: Request) {
  const token = await tokenFrom(req);
  if (!token || token.length < 16) return bad(401, "missing or invalid token");

  const rl = await consumeLimit(
    policies.uploadVerifyPerToken,
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

  // Resolve via the hashed token (also lazily migrates a legacy
  // plaintext row). Minimal disclosure: confirm validity + a character
  // COUNT only — never the account email or the character list.
  const userId = await resolveUploadTokenUserId(token);
  if (!userId) return bad(401, "token not recognized");

  const characters = await db.character.count({ where: { userId } });
  return NextResponse.json({ ok: true, characters });
}

export async function POST(req: Request) {
  return handle(req);
}

export async function GET(req: Request) {
  return handle(req);
}
