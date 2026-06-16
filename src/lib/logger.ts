import pino from "pino";
import { env } from "@/env";

const redactPaths = [
  "password",
  "passwordHash",
  "passphrase",
  "token",
  "tokens",
  "access_token",
  "refresh_token",
  "id_token",
  "sessionToken",
  "authorization",
  "Authorization",
  "cookie",
  "Cookie",
  "set-cookie",
  "Set-Cookie",
  "secret",
  "client_secret",
  "AUTH_SECRET",
  "SHARE_TOKEN_SECRET",
  "TOKEN_ENCRYPTION_KEY",
  "BLIZZARD_CLIENT_SECRET",
  "WCL_CLIENT_SECRET",
  "SMTP_PASSWORD",
  // PII + capability tokens — never log these, even if a whole object is passed.
  "email",
  "avatarUrl",
  "uploadToken",
  "shareToken",
  "*.password",
  "*.passwordHash",
  "*.token",
  "*.access_token",
  "*.refresh_token",
  "*.id_token",
  "*.sessionToken",
  "*.secret",
  "*.email",
  "*.avatarUrl",
  "*.uploadToken",
  "*.shareToken",
  "headers.authorization",
  "headers.cookie",
  "headers['set-cookie']",
  "request.headers.authorization",
  "request.headers.cookie",
];

const isDev = env.NODE_ENV !== "production";
// SKIP_ENV_VALIDATION=1 (used in Docker builds) bypasses zod defaults, so
// env.LOG_LEVEL can be undefined here. Pino errors out with "default
// level:undefined must be included in custom levels" — provide a safe
// runtime fallback.
const level = env.LOG_LEVEL ?? "info";

export const logger = pino({
  level,
  redact: {
    paths: redactPaths,
    censor: "[redacted]",
  },
  base: { service: "raid-team-stats" },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label }),
  },
  ...(isDev
    ? {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "SYS:HH:MM:ss.l" },
        },
      }
    : {}),
});

export type Logger = typeof logger;
