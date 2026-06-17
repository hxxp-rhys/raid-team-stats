import { PrismaAdapter } from "@auth/prisma-adapter";
import type { Adapter, AdapterUser } from "next-auth/adapters";

import { db } from "@/lib/db";
import { emailBlindIndex } from "@/server/auth/email-index";

/**
 * Auth.js adapter wrapper.
 *
 * Our `User` model uses `displayName` / `avatarUrl` (not the adapter's
 * expected `name` / `image`) and now allows a NULL `email` (Battle.net
 * sign-ups have none). The stock PrismaAdapter's `createUser` / `updateUser`
 * write `name` / `image` columns that don't exist here, so we override the
 * user-facing methods to map between the two shapes. Account/session/token
 * methods keep the stock implementation (our Account/Session models match the
 * adapter's expected shape, and token encryption rides on the Prisma
 * extension in `@/lib/db`).
 *
 * Auth.js's `AdapterUser` types `email` as a required string; an email-less
 * Battle.net user surfaces as `""` at this boundary only. Nothing looks a
 * user up by `""` — credential auth queries the DB directly — and the DB
 * column is genuinely NULL, so there's no collision.
 */
type UserRow = {
  id: string;
  email: string | null;
  emailVerified: Date | null;
  displayName: string | null;
  avatarUrl: string | null;
};

const USER_SELECT = {
  id: true,
  email: true,
  emailVerified: true,
  displayName: true,
  avatarUrl: true,
} as const;

const toAdapterUser = (u: UserRow): AdapterUser => ({
  id: u.id,
  email: u.email ?? "",
  emailVerified: u.emailVerified,
  name: u.displayName,
  image: u.avatarUrl,
});

const normaliseEmail = (email: unknown): string | null =>
  typeof email === "string" && email.length > 0 ? email : null;

export function buildAuthAdapter(): Adapter {
  const base = PrismaAdapter(
    db as unknown as Parameters<typeof PrismaAdapter>[0],
  );

  return {
    ...base,

    createUser: async (data) => {
      // Ignore any incoming id — let Prisma mint a cuid.
      const created = await db.user.create({
        data: {
          email: normaliseEmail(data.email),
          emailVerified: data.emailVerified ?? null,
          displayName: data.name ?? null,
          avatarUrl: data.image ?? null,
        },
        select: USER_SELECT,
      });
      return toAdapterUser(created);
    },

    updateUser: async (data) => {
      const { id } = data;
      if (!id) throw new Error("updateUser called without an id");
      const updated = await db.user.update({
        where: { id },
        data: {
          ...("email" in data ? { email: normaliseEmail(data.email) } : {}),
          ...("emailVerified" in data
            ? { emailVerified: data.emailVerified ?? null }
            : {}),
          ...("name" in data ? { displayName: data.name ?? null } : {}),
          ...("image" in data ? { avatarUrl: data.image ?? null } : {}),
        },
        select: USER_SELECT,
      });
      return toAdapterUser(updated);
    },

    getUser: async (id) => {
      const u = await db.user.findUnique({ where: { id }, select: USER_SELECT });
      return u ? toAdapterUser(u) : null;
    },

    getUserByEmail: async (email) => {
      // Email is encrypted at rest; look up by its blind index.
      const idx = emailBlindIndex(email);
      if (!idx) return null;
      const u = await db.user.findUnique({
        where: { emailIndex: idx },
        select: USER_SELECT,
      });
      return u ? toAdapterUser(u) : null;
    },

    getUserByAccount: async (providerAccountId) => {
      const acct = await db.account.findUnique({
        where: { provider_providerAccountId: providerAccountId },
        select: { user: { select: USER_SELECT } },
      });
      return acct?.user ? toAdapterUser(acct.user) : null;
    },
  };
}
