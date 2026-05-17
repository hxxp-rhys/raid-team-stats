import { NextResponse } from "next/server";

import { db } from "@/lib/db";

/**
 * Lightweight token-validation endpoint for the MSI installer (and the
 * Account page). Given an upload token it confirms whether it's valid and
 * returns the owning account + linked characters so the installer can show
 * "Verified — N characters" before finishing. No payload, no side effects.
 *
 * Deliberately NOT under /api/ (Cloudflare 404s new /api paths on this
 * zone — sibling of /uploader/ingest + /uploader/download which work).
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

  const user = await db.user.findUnique({
    where: { uploadToken: token },
    select: {
      email: true,
      characters: {
        select: { name: true, realmSlug: true, region: true },
        orderBy: { name: "asc" },
        take: 50,
      },
    },
  });
  if (!user) return bad(401, "token not recognized");

  return NextResponse.json({
    ok: true,
    account: user.email,
    characters: user.characters.map((c) => ({
      name: c.name,
      realm: c.realmSlug,
      region: c.region,
    })),
  });
}

export async function POST(req: Request) {
  return handle(req);
}

export async function GET(req: Request) {
  return handle(req);
}
