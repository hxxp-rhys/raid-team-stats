import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

const requiredInProd = (schema: z.ZodTypeAny) =>
  process.env.NODE_ENV === "production" ? schema : schema.optional();

export const env = createEnv({
  server: {
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

    DATABASE_URL: z
      .string()
      .min(1)
      .refine(
        (v) => v.startsWith("postgres://") || v.startsWith("postgresql://"),
        "DATABASE_URL must be a postgres connection string",
      ),

    REDIS_URL: z
      .string()
      .min(1)
      .refine(
        (v) => v.startsWith("redis://") || v.startsWith("rediss://"),
        "REDIS_URL must be a redis connection string",
      ),

    AUTH_SECRET: z
      .string()
      .min(32, "AUTH_SECRET must be at least 32 chars (use `openssl rand -base64 48`)"),

    APP_URL: z.string().url().default("http://localhost:3000"),

    LOG_LEVEL: z
      .enum(["trace", "debug", "info", "warn", "error", "fatal"])
      .default("info"),

    TOKEN_ENCRYPTION_KEY: z
      .string()
      .regex(
        /^[A-Za-z0-9+/=]{43,}$/,
        "TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key (use `openssl rand -base64 32`)",
      ),

    BLIZZARD_CLIENT_ID: requiredInProd(z.string().min(1)),
    BLIZZARD_CLIENT_SECRET: requiredInProd(z.string().min(1)),
    BLIZZARD_REGION: z.enum(["us", "eu", "kr", "tw"]).default("us"),

    WCL_CLIENT_ID: requiredInProd(z.string().min(1)),
    WCL_CLIENT_SECRET: requiredInProd(z.string().min(1)),
    WCL_HOURLY_POINTS_BUDGET: z.coerce.number().int().positive().default(17000),

    RAIDERIO_API_KEY: z.string().optional(),

    SMTP_HOST: requiredInProd(z.string().min(1)),
    SMTP_PORT: z.coerce.number().int().positive().default(587),
    SMTP_USER: requiredInProd(z.string().min(1)),
    SMTP_PASSWORD: requiredInProd(z.string().min(1)),
    SMTP_FROM: requiredInProd(z.string().email()),

    ADMIN_USER_IDS: z
      .string()
      .default("")
      .transform((v) =>
        v
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      ),

    RATE_LIMIT_TRUST_PROXY: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
  },

  client: {
    NEXT_PUBLIC_APP_NAME: z.string().default("Raid Team Stats"),
  },

  runtimeEnv: {
    NODE_ENV: process.env.NODE_ENV,
    DATABASE_URL: process.env.DATABASE_URL,
    REDIS_URL: process.env.REDIS_URL,
    AUTH_SECRET: process.env.AUTH_SECRET,
    APP_URL: process.env.APP_URL,
    LOG_LEVEL: process.env.LOG_LEVEL,
    TOKEN_ENCRYPTION_KEY: process.env.TOKEN_ENCRYPTION_KEY,
    BLIZZARD_CLIENT_ID: process.env.BLIZZARD_CLIENT_ID,
    BLIZZARD_CLIENT_SECRET: process.env.BLIZZARD_CLIENT_SECRET,
    BLIZZARD_REGION: process.env.BLIZZARD_REGION,
    WCL_CLIENT_ID: process.env.WCL_CLIENT_ID,
    WCL_CLIENT_SECRET: process.env.WCL_CLIENT_SECRET,
    WCL_HOURLY_POINTS_BUDGET: process.env.WCL_HOURLY_POINTS_BUDGET,
    RAIDERIO_API_KEY: process.env.RAIDERIO_API_KEY,
    SMTP_HOST: process.env.SMTP_HOST,
    SMTP_PORT: process.env.SMTP_PORT,
    SMTP_USER: process.env.SMTP_USER,
    SMTP_PASSWORD: process.env.SMTP_PASSWORD,
    SMTP_FROM: process.env.SMTP_FROM,
    ADMIN_USER_IDS: process.env.ADMIN_USER_IDS,
    RATE_LIMIT_TRUST_PROXY: process.env.RATE_LIMIT_TRUST_PROXY,
    NEXT_PUBLIC_APP_NAME: process.env.NEXT_PUBLIC_APP_NAME,
  },

  emptyStringAsUndefined: true,
  skipValidation: process.env.SKIP_ENV_VALIDATION === "1",
});
