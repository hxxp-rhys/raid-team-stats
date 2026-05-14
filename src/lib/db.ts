import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { env } from "@/env";
import { logger } from "@/lib/logger";
import { encryptToken, decryptToken, isEncrypted } from "@/server/crypto/token-cipher";

/**
 * Transparent column-level encryption for OAuth tokens stored in the Account
 * table. Layered on top of database-level encryption-at-rest (defense in depth).
 *
 * The cipher is idempotent: writes skip already-encrypted values, reads return
 * plaintext as-is if a row predates the extension. Decrypt failures (wrong
 * key, tampering) become null rather than throwing, so a single bad row never
 * takes down an auth flow — it surfaces as a forced re-link instead.
 */
const ENCRYPTED_FIELDS = ["access_token", "refresh_token", "id_token"] as const;

type MutableRecord = Record<string, unknown>;

const encryptInPlace = (data: MutableRecord | null | undefined): void => {
  if (!data) return;
  for (const field of ENCRYPTED_FIELDS) {
    const v = data[field];
    if (typeof v === "string" && v.length > 0 && !isEncrypted(v)) {
      data[field] = encryptToken(v);
    }
  }
};

const decryptInPlace = (data: MutableRecord | null | undefined): void => {
  if (!data) return;
  for (const field of ENCRYPTED_FIELDS) {
    const v = data[field];
    if (typeof v === "string" && isEncrypted(v)) {
      try {
        data[field] = decryptToken(v);
      } catch (err) {
        logger.error(
          { err, field },
          "account token decrypt failed; setting to null so auth flow can recover",
        );
        data[field] = null;
      }
    }
  }
};

const buildClient = () => {
  const adapter = new PrismaPg({ connectionString: env.DATABASE_URL });
  const base = new PrismaClient({
    adapter,
    log: [
      { level: "warn", emit: "stdout" },
      { level: "error", emit: "stdout" },
    ],
  });

  return base.$extends({
    name: "encryptAccountTokens",
    query: {
      account: {
        async create({ args, query }) {
          encryptInPlace(args.data as MutableRecord);
          const result = await query(args);
          decryptInPlace(result as unknown as MutableRecord);
          return result;
        },
        async createMany({ args, query }) {
          if (Array.isArray(args.data)) {
            for (const d of args.data) encryptInPlace(d as MutableRecord);
          } else {
            encryptInPlace(args.data as MutableRecord);
          }
          return query(args);
        },
        async update({ args, query }) {
          encryptInPlace(args.data as MutableRecord);
          const result = await query(args);
          decryptInPlace(result as unknown as MutableRecord);
          return result;
        },
        async updateMany({ args, query }) {
          encryptInPlace(args.data as MutableRecord);
          return query(args);
        },
        async upsert({ args, query }) {
          encryptInPlace(args.create as MutableRecord);
          encryptInPlace(args.update as MutableRecord);
          const result = await query(args);
          decryptInPlace(result as unknown as MutableRecord);
          return result;
        },
        async findUnique({ args, query }) {
          const result = await query(args);
          decryptInPlace(result as unknown as MutableRecord);
          return result;
        },
        async findUniqueOrThrow({ args, query }) {
          const result = await query(args);
          decryptInPlace(result as unknown as MutableRecord);
          return result;
        },
        async findFirst({ args, query }) {
          const result = await query(args);
          decryptInPlace(result as unknown as MutableRecord);
          return result;
        },
        async findFirstOrThrow({ args, query }) {
          const result = await query(args);
          decryptInPlace(result as unknown as MutableRecord);
          return result;
        },
        async findMany({ args, query }) {
          const result = await query(args);
          if (Array.isArray(result)) {
            for (const r of result) decryptInPlace(r as MutableRecord);
          }
          return result;
        },
      },
    },
  });
};

export type ExtendedPrismaClient = ReturnType<typeof buildClient>;

const globalForPrisma = globalThis as unknown as { __prisma?: ExtendedPrismaClient };

export const db: ExtendedPrismaClient = globalForPrisma.__prisma ?? buildClient();

if (env.NODE_ENV !== "production") {
  globalForPrisma.__prisma = db;
}
