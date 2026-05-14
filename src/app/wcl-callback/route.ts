import { connection } from "next/server";
import { NextResponse } from "next/server";
import { env } from "@/env";

/**
 * Warcraft Logs OAuth callback — reserved for the user-link flow shipped in
 * v1.1. v1 uses WCL via client-credentials only and never invokes this URL.
 *
 * Registered with the WCL developer console (env: WCL_REDIRECT_URI) so the
 * URL is committed and stable across deployments. If reached before the
 * user-link flow exists, redirects the user back to their profile.
 */
export async function GET(): Promise<NextResponse> {
  await connection();
  return NextResponse.redirect(new URL("/profile?wcl=not-yet", env.APP_URL), {
    status: 307,
  });
}
