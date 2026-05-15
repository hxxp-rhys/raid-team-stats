import NextAuth from "next-auth";
import type { NextAuthConfig, Session } from "next-auth";
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
        mfaCode: { label: "Authenticator code", type: "text" },
      },
      async authorize(rawCredentials) {
        const parsed = credentialsSchema.safeParse(rawCredentials);
        if (!parsed.success) return null;
        const { email, password } = parsed.data;
        const mfaCode =
          typeof rawCredentials?.mfaCode === "string"
            ? rawCredentials.mfaCode
            : "";

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
          const { authEventsTotal } = await import("@/lib/metrics");
          authEventsTotal.inc({ event: "login_failure" });
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
          const { authEventsTotal } = await import("@/lib/metrics");
          authEventsTotal.inc({ event: "login_failure" });
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

        // MFA gate. If enabled, require a valid TOTP / recovery code before
        // returning the user. The /signin client treats the "mfa_required"
        // error as a signal to render the code-input step.
        if (user.mfaEnabled) {
          const { isMfaEnabled, verifyAnyMfaCode } = await import(
            "@/server/auth/mfa"
          );
          if (await isMfaEnabled(user.id)) {
            const { authEventsTotal: m } = await import("@/lib/metrics");
            if (!mfaCode) {
              m.inc({ event: "mfa_required" });
              throw new Error("mfa_required");
            }
            const mfaOk = await verifyAnyMfaCode(user.id, mfaCode);
            if (!mfaOk) {
              await audit({
                event: "AUTH_LOGIN_FAILURE",
                actorUserId: user.id,
                metadata: { reason: "mfa_failed" },
                ip: ip ?? undefined,
              });
              m.inc({ event: "mfa_failure" });
              throw new Error("Authenticator code is incorrect or expired.");
            }
          }
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

        const { authEventsTotal: m } = await import("@/lib/metrics");
        m.inc({ event: "login_success" });
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
      // Auth.js v5's default for OIDC providers is `checks: ["pkce"]`, but
      // Battle.net has two extra requirements:
      //   1. Authorize requests must include `state` ("The state parameter
      //      must be provided") — not optional even with PKCE.
      //   2. The ID token returned at /token always contains a `nonce` claim;
      //      with `nonce` not in checks, Auth.js gets a nonce it didn't send
      //      and errors with "unexpected ID Token nonce claim value".
      // Enabling all three matches Battle.net's actual behavior.
      checks: ["pkce", "state", "nonce"],
      authorization: {
        params: {
          scope: "openid wow.profile",
        },
      },
      // NOTE: do NOT override `authorization.params.redirect_uri`. Auth.js
      // uses `provider.callbackUrl` (= `/api/auth/callback/battlenet`) at
      // the token-exchange step regardless of what we put on the authorize
      // request — overriding only one side produces "invalid_grant: Redirect
      // URI mismatch". Register the Auth.js-default URL with Battle.net.
    }),
  ],

  callbacks: {
    async signIn({ user, account, profile }) {
      // Battle.net is a link-to-existing-account flow, not a primary identity.
      // The user must already be signed in (via Credentials) when they click
      // "Link Battle.net". We attach the Battle.net Account row to their
      // current session's user, and refuse to create a new user from Battle.net.
      if (account?.provider === "battlenet") {
        const battletag =
          typeof profile?.battle_tag === "string" ? profile.battle_tag : "unknown";

        // Read the current session cookie. If absent, the click can't be
        // attributed to an existing user — refuse.
        const current = (await (auth as unknown as () => Promise<Session | null>)()) ?? null;
        if (!current?.user?.id) {
          logger.warn({ battletag }, "rejected Battle.net sign-in: not currently signed in");
          return false;
        }

        // Already linked? Confirm it's the same user.
        const existing = await db.account.findFirst({
          where: { provider: "battlenet", providerAccountId: account.providerAccountId },
        });
        if (existing) {
          if (existing.userId !== current.user.id) {
            logger.warn(
              { battletag, currentUserId: current.user.id, owningUserId: existing.userId },
              "rejected Battle.net sign-in: providerAccountId belongs to a different user",
            );
            return false;
          }
          // Idempotent re-link: refresh tokens on the existing row.
          await db.account.update({
            where: { id: existing.id },
            data: {
              access_token: account.access_token,
              refresh_token: account.refresh_token,
              id_token: account.id_token,
              expires_at: account.expires_at,
              token_type: account.token_type,
              scope: account.scope,
            },
          });
          return "/profile?bnet=already-linked";
        }

        // First link: manually create the Account row attached to the current
        // session user. The Prisma extension transparently encrypts tokens.
        await db.account.create({
          data: {
            userId: current.user.id,
            type: account.type,
            provider: account.provider,
            providerAccountId: account.providerAccountId,
            access_token: account.access_token,
            refresh_token: account.refresh_token,
            id_token: account.id_token,
            expires_at: account.expires_at,
            token_type: account.token_type,
            scope: account.scope,
            session_state:
              typeof account.session_state === "string" ? account.session_state : null,
          },
        });

        logger.info(
          { battletag, userId: current.user.id },
          "Battle.net account linked to existing user",
        );

        // Returning a redirect URL keeps the user on their existing JWT session
        // (Auth.js does not mint a new session for the synthesized Battle.net
        // user) and avoids the duplicate-User-row that returning `true` would
        // produce.
        return "/profile?bnet=linked";
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
