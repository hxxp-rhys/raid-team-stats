import { consumeLimit, policies } from "@/server/security/rate-limit";

/**
 * Per-email + per-IP credentials throttle. Returns the worst-case result so
 * the caller can emit one consistent error. Records consumption in BOTH
 * buckets regardless of whether the attempt succeeds — login attempts cost a
 * slot whether or not they would have worked.
 */
export async function consumeLoginAttempt(opts: { email: string; ip: string | null }) {
  const emailKey = opts.email.toLowerCase().trim();
  const ipKey = opts.ip ?? "no-ip";

  const [byEmail, byIp] = await Promise.all([
    consumeLimit(policies.authLoginPerEmail, emailKey),
    consumeLimit(policies.authLoginPerIp, ipKey),
  ]);

  const denied = !byEmail.allowed || !byIp.allowed;
  const limit = denied
    ? byEmail.allowed
      ? byIp
      : byEmail
    : byEmail.remaining < byIp.remaining
      ? byEmail
      : byIp;

  return {
    allowed: !denied,
    retryAfterMs: Math.max(0, limit.resetAt - Date.now()),
  };
}
