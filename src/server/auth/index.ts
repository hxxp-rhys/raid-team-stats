import NextAuth from "next-auth";
import type { NextAuthConfig } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import BattleNet, { type BattleNetIssuer } from "next-auth/providers/battlenet";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { headers } from "next/headers";

import { db } from "@/lib/db";
import { env } from "@/env";
import { logger } from "@/lib/logger";
import { verifyPassword, needsRehash, hashPassword } from "@/server/crypto/kdf";
import { audit } from "@/server/security/audit";
import { consumeLoginAttempt } from "@/server/auth/login-throttle";
import { credentialsSchema } from "@/server/auth/schemas";
import { redis } from "@/lib/redis";

const battlenetIssuer: BattleNetIssuer = `https://${env.BLIZZARD_REGION}.battle.net/oauth`;

const REVOKED_TOKEN_KEY = (jti: string) => `auth:revoked:${jti}`;

/**
 * Auth.js v5 configuration.
 *
 * Session strategy: JWT (required for Credentials provider). Instant
 * revocation is implemented via a Redis set keyed by JWT id (`jti`);
 * `signOut` adds the current jti to the set, and the `jwt` callback rejects
 * tokens whose jti is present.
 *
 * Battle.net provider is registered as a *secondary* identity — the user must
 * already have an email-verified account before linking. The `signIn`
 * callback enforces this (refuses to create new users from Battle.net
 * sign-in). Linking flow lives in `src/server/auth/link-battlenet.ts`.
 */
const config: NextAuthConfig = {
  // Cast: the extended client structurally matches the adapter's expected shape;
  // Prisma 7 type-narrowing through $extends doesn't preserve the loose
  // PrismaClient interface PrismaAdapter declares.
  adapter: PrismaAdapter(db as unknown as Parameters<typeof PrismaAdapter>[0]),
  secret: env.AUTH_SECRET,
  trustHost: true, // proxy.ts validates request origin and rate-limits

  session: {
    strategy: "jwt",
    maxAge: 60 * 60 * 24 * 7, // 7 days
    updateAge: 60 * 60, // refresh JWT every hour of active use
  },

  jwt: {
    maxAge: 60 * 60 * 24 * 7,
  },

  pages: {
    signIn: "/signin",
    signOut: "/signout",
    error: "/signin",
    verifyRequest: "/verify",
    newUser: "/profile",
  },

  providers: [
    Credentials({
      name: "Credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(rawCredentials) {
        const parsed = credentialsSchema.safeParse(rawCredentials);
        if (!parsed.success) return null;
        const { email, password } = parsed.data;

        const ip = await readClientIp();
        const throttle = await consumeLoginAttempt({ email, ip });
        if (!throttle.allowed) {
          await audit({
            event: "AUTH_LOGIN_FAILURE",
            subjectType: "user",
            metadata: { reason: "rate_limited" },
            ip: ip ?? undefined,
          });
          // Generic message: never disclose whether the rate-limit was on
          // email or IP.
          throw new Error("Too many sign-in attempts. Please wait and try again.");
        }

        const user = await db.user.findUnique({
          where: { email },
          include: { credential: true },
        });
        if (!user || !user.credential) {
          await audit({
            event: "AUTH_LOGIN_FAILURE",
            metadata: { reason: "unknown_account" },
            ip: ip ?? undefined,
          });
          return null;
        }

        const ok = await verifyPassword(user.credential.passwordHash, password);
        if (!ok) {
          await audit({
            event: "AUTH_LOGIN_FAILURE",
            actorUserId: user.id,
            metadata: { reason: "bad_password" },
            ip: ip ?? undefined,
          });
          return null;
        }

        // Require email verification before allowing sign-in.
        if (!user.emailVerified) {
          await audit({
            event: "AUTH_LOGIN_FAILURE",
            actorUserId: user.id,
            metadata: { reason: "email_not_verified" },
            ip: ip ?? undefined,
          });
          throw new Error("Please verify your email address before signing in.");
        }

        // Opportunistically upgrade the hash if the Argon2 parameters changed.
        if (needsRehash(user.credential.passwordHash)) {
          try {
            const fresh = await hashPassword(password);
            await db.credential.update({
              where: { userId: user.id },
              data: { passwordHash: fresh, lastChangedAt: new Date() },
            });
          } catch (err) {
            logger.warn({ err, userId: user.id }, "opportunistic rehash failed");
          }
        }

        return {
          id: user.id,
          email: user.email,
          name: user.displayName ?? null,
          image: user.avatarUrl ?? null,
        };
      },
    }),

    BattleNet({
      // In development these env vars are optional so the app can boot without
      // Battle.net credentials; the provider will simply fail at OAuth-start
      // with a clear error if anyone tries to sign in via this provider.
      clientId: env.BLIZZARD_CLIENT_ID ?? "",
      clientSecret: env.BLIZZARD_CLIENT_SECRET ?? "",
      issuer: battlenetIssuer,
      authorization: {
        params: {
          scope: "openid wow.profile",
          // Override Auth.js's auto-generated redirect URI so it matches the
          // value registered with Battle.net. The actual handler lives at
          // `/bnet-login-callback` and proxies into Auth.js's catch-all.
          redirect_uri: env.BATTLENET_REDIRECT_URI,
        },
      },
    }),
  ],

  callbacks: {
    async signIn({ user, account, profile }) {
      // Reject Battle.net sign-ins for accounts that haven't been pre-linked.
      // Battle.net is a link-to-existing flow, not a primary identity source.
      if (account?.provider === "battlenet") {
        const battletag =
          typeof profile?.battle_tag === "string" ? profile.battle_tag : "unknown";

        if (!user?.email) {
          // Auth.js calls signIn with a synthesized user when no DB row exists.
          // We refuse to create one.
          logger.warn({ battletag }, "rejected Battle.net sign-in: no linked user");
          return false;
        }

        const existing = await db.account.findFirst({
          where: { provider: "battlenet", providerAccountId: account.providerAccountId },
        });

        if (!existing) {
          logger.warn({ battletag, userId: user.id }, "rejected Battle.net sign-in: not linked");
          return false;
        }
      }
      return true;
    },

    async jwt({ token, user, account }) {
      // First sign-in: stamp identity + jti for revocation.
      if (user) {
        token.userId = user.id;
        token.jti = crypto.randomUUID();
      }

      if (account?.provider === "battlenet") {
        token.battlenetLinkedAt = Date.now();
      }

      // Reject revoked tokens (instant logout).
      if (typeof token.jti === "string") {
        const revoked = await redis.get(REVOKED_TOKEN_KEY(token.jti));
        if (revoked) return null;
      }

      return token;
    },

    async session({ session, token }) {
      if (typeof token.userId === "string") {
        session.user.id = token.userId;
      }
      return session;
    },
  },

  events: {
    async signIn({ user, account, isNewUser }) {
      await audit({
        event: "AUTH_LOGIN_SUCCESS",
        actorUserId: user.id,
        metadata: {
          provider: account?.provider,
          isNewUser: Boolean(isNewUser),
        },
      });
    },
    async signOut(message) {
      // JWT strategy always emits { token } here; the { session } variant fires
      // only with the DB session strategy.
      const token = "token" in message ? message.token : null;
      const userId = typeof token?.userId === "string" ? token.userId : null;
      const jti = typeof token?.jti === "string" ? token.jti : null;

      if (jti) {
        // Revoke the JWT for the remainder of its lifetime.
        await redis.set(REVOKED_TOKEN_KEY(jti), "1", "EX", 60 * 60 * 24 * 8);
      }

      await audit({
        event: "AUTH_LOGOUT",
        actorUserId: userId,
      });
    },
    async linkAccount({ user, account }) {
      await audit({
        event:
          account.provider === "battlenet" ? "AUTH_BATTLENET_LINKED" : "AUTH_LOGIN_SUCCESS",
        actorUserId: user.id,
        metadata: { provider: account.provider },
      });
    },
  },

  // The cookie names default to NextAuth's conventional values which already
  // include the __Secure- prefix in production (https only).
};

async function readClientIp(): Promise<string | null> {
  try {
    const h = await headers();
    return (
      h.get("x-real-ip") ??
      h.get("cf-connecting-ip") ??
      h.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      null
    );
  } catch {
    return null;
  }
}

export const { handlers, signIn, signOut, auth } = NextAuth(config);
