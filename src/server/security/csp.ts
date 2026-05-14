import { randomBytes } from "node:crypto";

/**
 * Generates a cryptographically random nonce suitable for inline scripts/styles
 * within a strict Content-Security-Policy. Base64 (no padding stripping — the
 * spec requires the full base64 token as emitted).
 */
export const newCspNonce = (): string => randomBytes(16).toString("base64");

type BuildOptions = {
  nonce: string;
  isDev: boolean;
};

/**
 * Strict, nonce-based Content-Security-Policy. No `unsafe-inline`.
 * `strict-dynamic` allows scripts loaded by trusted (nonced) scripts.
 *
 * Dev mode loosens script-src to allow `unsafe-eval` for Next/Turbopack HMR.
 * Connect-src includes ws: for the dev HMR socket.
 */
export const buildCsp = ({ nonce, isDev }: BuildOptions): string => {
  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
    "frame-ancestors": ["'none'"],
    "object-src": ["'none'"],
    "img-src": ["'self'", "data:", "https://render.worldofwarcraft.com", "https://wow.zamimg.com"],
    "font-src": ["'self'", "data:"],
    "script-src": [
      "'self'",
      `'nonce-${nonce}'`,
      "'strict-dynamic'",
      ...(isDev ? ["'unsafe-eval'"] : []),
    ],
    "style-src": ["'self'", `'nonce-${nonce}'`],
    "style-src-elem": ["'self'", `'nonce-${nonce}'`],
    "connect-src": [
      "'self'",
      ...(isDev ? ["ws:", "wss:"] : []),
    ],
    "worker-src": ["'self'", "blob:"],
    "manifest-src": ["'self'"],
    "upgrade-insecure-requests": [],
  };

  return Object.entries(directives)
    .map(([k, v]) => (v.length === 0 ? k : `${k} ${v.join(" ")}`))
    .join("; ");
};

export const CSP_NONCE_HEADER = "x-csp-nonce";
