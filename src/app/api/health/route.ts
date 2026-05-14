import { NextResponse } from "next/server";
import { connection } from "next/server";

/**
 * Liveness probe. Returns 200 as long as the process can serve HTTP.
 * Does not touch the DB or Redis — readiness covers those.
 */
export async function GET() {
  await connection(); // force dynamic: probe must be fresh each call
  return NextResponse.json(
    { status: "ok", service: "raid-team-stats" },
    { headers: { "Cache-Control": "no-store" } },
  );
}
