// Vitest setup: ensure env vars are populated so `src/env.ts` validates.
// Production secrets aren't needed for unit tests of pure crypto / parsers.

(process.env as Record<string, string>).NODE_ENV ??= "test";
process.env.APP_URL ??= "http://localhost:3000";
process.env.LOG_LEVEL ??= "warn";
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test?schema=public";
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.AUTH_SECRET ??= "test-only-auth-secret-not-for-real-use-must-be-32-chars-long";
// base64("test-encryption-key-32bytes-aaaa") — decodes to exactly 32 bytes.
process.env.TOKEN_ENCRYPTION_KEY ??= "dGVzdC1lbmNyeXB0aW9uLWtleS0zMmJ5dGVzLWFhYWE=";
process.env.BLIZZARD_REGION ??= "us";
process.env.WCL_HOURLY_POINTS_BUDGET ??= "17000";
process.env.SMTP_PORT ??= "587";
process.env.RATE_LIMIT_TRUST_PROXY ??= "false";
process.env.NEXT_PUBLIC_APP_NAME ??= "Raid Team Stats";
