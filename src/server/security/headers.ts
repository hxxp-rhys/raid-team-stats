import type { NextResponse } from "next/server";
import { buildCsp, CSP_NONCE_HEADER } from "@/server/security/csp";

type ApplyOptions = {
  response: NextResponse;
  nonce: string;
  isDev: boolean;
  isHttps: boolean;
};

/**
 * Applies the security header set to a response. Idempotent: calling twice
 * with the same response is safe but redundant.
 */
export const applySecurityHeaders = ({ response, nonce, isDev, isHttps }: ApplyOptions) => {
  response.headers.set("Content-Security-Policy", buildCsp({ nonce, isDev }));
  response.headers.set(CSP_NONCE_HEADER, nonce);

  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");

  // Minimal permissions policy: deny everything we don't explicitly use.
  response.headers.set(
    "Permissions-Policy",
    [
      "accelerometer=()",
      "camera=()",
      "geolocation=()",
      "gyroscope=()",
      "magnetometer=()",
      "microphone=()",
      "payment=()",
      "usb=()",
      "interest-cohort=()",
    ].join(", "),
  );

  response.headers.set("Cross-Origin-Opener-Policy", "same-origin");
  response.headers.set("Cross-Origin-Resource-Policy", "same-origin");

  if (isHttps) {
    response.headers.set(
      "Strict-Transport-Security",
      "max-age=63072000; includeSubDomains; preload",
    );
  }

  // Strip server fingerprinting where Next allows.
  response.headers.delete("X-Powered-By");

  return response;
};
