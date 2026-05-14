import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { env } from "@/env";

const buildClient = () => {
  const adapter = new PrismaPg({ connectionString: env.DATABASE_URL });
  return new PrismaClient({
    adapter,
    log:
      env.NODE_ENV === "production"
        ? [{ level: "warn", emit: "stdout" }, { level: "error", emit: "stdout" }]
        : [{ level: "warn", emit: "stdout" }, { level: "error", emit: "stdout" }],
  });
};

const globalForPrisma = globalThis as unknown as { __prisma?: PrismaClient };

export const db = globalForPrisma.__prisma ?? buildClient();

if (env.NODE_ENV !== "production") {
  globalForPrisma.__prisma = db;
}
