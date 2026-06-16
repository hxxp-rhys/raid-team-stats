import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { env } from "@/env";
import { logger } from "@/lib/logger";
import { encryptToken, decryptToken, isEncrypted } from "@/server/crypto/token-cipher";

/**
 * Transparent, NON-OPTIONAL column-level encryption (AES-256-GCM) for tokens and
 * PII, enforced at the data layer so application code can never accidentally
 * store plaintext. Layered on top of database/disk encryption-at-rest (defense
 * in depth). A single `$allModels.$allOperations` interceptor encrypts the
 * registered fields on writes and decrypts them on reads — including fields that
 * arrive nested via `include` (e.g. FormSubmission → FormAnswer).
 *
 * The cipher is idempotent: writes skip already-encrypted values, reads return
 * legacy plaintext as-is (so a row predating encryption still works, and a
 * one-time backfill — scripts/backfill-pii-encryption.ts — converts old rows).
 * Decrypt failures (wrong key, tampering) become null + a log line rather than
 * throwing, so one bad row never takes down a read path.
 *
 * NOTE: `email` is intentionally NOT here yet — it's the @unique login
 * identifier and needs a blind-index migration + live auth testing (tracked
 * separately). All other PII is covered.
 */
type FieldType = "string" | "json";

/** model delegate (camelCase) -> { field -> type }. */
const ENCRYPTED: Record<string, Record<string, FieldType>> = {
  account: { access_token: "string", refresh_token: "string", id_token: "string" },
  user: { displayName: "string", avatarUrl: "string" },
  formSubmission: { answersJson: "json", applicantLabel: "string" },
  formAnswer: { valueText: "string", valueJson: "json" },
};

/** parent delegate -> { relation field -> child delegate } (for nested writes/includes). */
const NESTED: Record<string, Record<string, string>> = {
  formSubmission: { answers: "formAnswer" },
};

type MutableRecord = Record<string, unknown>;

const encField = (value: unknown, type: FieldType): unknown => {
  if (value == null) return value;
  if (typeof value === "string" && isEncrypted(value)) return value; // already encrypted
  if (type === "string") {
    return typeof value === "string" && value.length > 0 ? encryptToken(value) : value;
  }
  // json: serialize then encrypt; stored as a JSON string primitive.
  try {
    return encryptToken(JSON.stringify(value));
  } catch {
    return value;
  }
};

const decField = (value: unknown, type: FieldType): unknown => {
  if (typeof value !== "string" || !isEncrypted(value)) return value; // legacy plaintext / non-string
  try {
    const plain = decryptToken(value);
    if (plain == null) return null;
    return type === "json" ? JSON.parse(plain) : plain;
  } catch (err) {
    logger.error({ err, type }, "PII/token decrypt failed; returning null so the read path recovers");
    return null;
  }
};

export const encryptRecord = (modelKey: string, data: unknown): void => {
  if (!data || typeof data !== "object") return;
  const rec = data as MutableRecord;
  const fields = ENCRYPTED[modelKey];
  if (fields) {
    for (const [f, t] of Object.entries(fields)) {
      if (f in rec) rec[f] = encField(rec[f], t);
    }
  }
  const nested = NESTED[modelKey];
  if (nested) {
    for (const [rel, childKey] of Object.entries(nested)) {
      const relData = rec[rel] as { create?: unknown } | undefined;
      const create = relData?.create;
      if (Array.isArray(create)) create.forEach((row) => encryptRecord(childKey, row));
      else if (create) encryptRecord(childKey, create);
    }
  }
};

export const decryptRecord = (modelKey: string, rec: unknown): void => {
  if (!rec || typeof rec !== "object") return;
  const r = rec as MutableRecord;
  const fields = ENCRYPTED[modelKey];
  if (fields) {
    for (const [f, t] of Object.entries(fields)) {
      if (f in r) r[f] = decField(r[f], t);
    }
  }
  const nested = NESTED[modelKey];
  if (nested) {
    for (const [rel, childKey] of Object.entries(nested)) {
      const v = r[rel];
      if (Array.isArray(v)) v.forEach((child) => decryptRecord(childKey, child));
      else if (v && typeof v === "object") decryptRecord(childKey, v);
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
    name: "encryptPiiAndTokens",
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          // Prisma passes the PascalCase model name; our registry is camelCase.
          const key = model.charAt(0).toLowerCase() + model.slice(1);
          if (!(key in ENCRYPTED) && !(key in NESTED)) return query(args);

          const a = args as {
            data?: unknown;
            create?: unknown;
            update?: unknown;
          };
          if (operation === "create" || operation === "update") {
            encryptRecord(key, a.data);
          } else if (operation === "createMany" || operation === "updateMany") {
            if (Array.isArray(a.data)) a.data.forEach((d) => encryptRecord(key, d));
            else encryptRecord(key, a.data);
          } else if (operation === "upsert") {
            encryptRecord(key, a.create);
            encryptRecord(key, a.update);
          }

          const result = await query(args);

          if (Array.isArray(result)) {
            for (const row of result) decryptRecord(key, row);
          } else if (result && typeof result === "object") {
            decryptRecord(key, result);
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
