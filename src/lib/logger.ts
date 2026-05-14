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
  "TOKEN_ENCRYPTION_KEY",
  "BLIZZARD_CLIENT_SECRET",
  "WCL_CLIENT_SECRET",
  "SMTP_PASSWORD",
  "*.password",
  "*.passwordHash",
  "*.token",
  "*.access_token",
  "*.refresh_token",
  "*.id_token",
  "*.sessionToken",
  "*.secret",
  "headers.authorization",
  "headers.cookie",
  "headers['set-cookie']",
  "request.headers.authorization",
  "request.headers.cookie",
];

const isDev = env.NODE_ENV !== "production";

export const logger = pino({
  level: env.LOG_LEVEL,
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
