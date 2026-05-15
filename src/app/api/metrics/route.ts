import { NextResponse } from "next/server";
import { connection } from "next/server";
import type { Session } from "next-auth";

import { auth } from "@/server/auth";
import { env } from "@/env";
import { registry } from "@/lib/metrics";

/**
 * Prometheus scrape endpoint. Gated two ways:
 *
 *   1. Bearer token via `Authorization: Bearer <METRICS_TOKEN>` — for the
 *      Prometheus container to scrape without a user session. The token
 *      lives in env (METRICS_TOKEN). When unset, only the user-session path
 *      below works (useful in dev).
 *   2. Authenticated platform admin via Auth.js session, gated on
 *      ADMIN_USER_IDS. Allows a human to spot-check via browser.
 *
 * Anyone else gets 404 so the metrics surface stays undiscoverable.
 */
export async function GET(req: Request) {
  await connection();

  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
  // Route through `env` so the empty-string-as-undefined transform applies and
  // a stray `METRICS_TOKEN=""` doesn't accidentally enable token mode with an
  // empty expected value.
  const expected = env.METRICS_TOKEN ?? null;

  const tokenOk = !!expected && !!bearer && bearer === expected;
  let sessionOk = false;
  if (!tokenOk) {
    const session = (await (auth as unknown as () => Promise<Session | null>)()) ?? null;
    sessionOk =
      !!session?.user?.id && env.ADMIN_USER_IDS.includes(session.user.id);
  }

  if (!tokenOk && !sessionOk) {
    return new NextResponse("Not found", { status: 404 });
  }

  const body = await registry.metrics();
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": registry.contentType,
      "Cache-Control": "no-store",
    },
  });
}
