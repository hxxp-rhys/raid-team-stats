import NextAuth from "next-auth";
import type { NextAuthConfig, Session } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import BattleNet, { type BattleNetIssuer } from "next-auth/providers/battlenet";
import { headers } from "next/headers";

import { db } from "@/lib/db";
import { buildAuthAdapter } from "@/server/auth/adapter";
import { emailBlindIndex } from "@/server/auth/email-index";
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
 * Battle.net is LINK-ONLY (not a primary identity): signing in with it signs
 * you in as the user who owns that link, or — if you're already signed in —
 * links it to your account. It does NOT create accounts: Battle.net exposes no
 * email, so an auto-created account would be email-less (can't be admin-by-
 * email, has no password to recover, orphans the user's data). A Battle.net
 * login with no linked account is refused with a "register with your email
 * first, then link" message. The `signIn` callback below implements the three
 * cases. Email/password is the primary identity; Battle.net attaches to it.
 */
const config: NextAuthConfig = {
  // Wrapped adapter maps our displayName/avatarUrl ↔ the adapter's name/image
  // and tolerates a null email, so Auth.js can auto-create Battle.net users
  // against this schema. See src/server/auth/adapter.ts.
  adapter: buildAuthAdapter(),
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

        const idx = emailBlindIndex(email);
        const user = idx
          ? await db.user.findUnique({
              where: { emailIndex: idx },
              include: { credential: true },
            })
          : null;
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
      // Battle.net is a PRIMARY identity. Three cases behind the one OAuth
      // callback, distinguished by (is this Battle.net already linked?) and
      // (is there a current session?):
      //
      //   1. LINKED → sign in AS the owning user. If the current session is a
      //      different user, this SWITCHES to the Battle.net owner (a button
      //      labelled "Sign in with Battle.net" should make you the
      //      Battle.net user). Re-link/refresh of your own account also lands
      //      here and just refreshes tokens.
      //   2. NOT linked, signed in → attach Battle.net to the current user
      //      (the /account "Link Battle.net" flow). Manual create + redirect
      //      keeps the existing session.
      //   3. NOT linked, not signed in → REFUSE (link-only). Battle.net must
      //      not create accounts (it exposes no email). Redirect back to
      //      /signin with a "register with your email first, then link" notice.
      if (account?.provider === "battlenet") {
        const battletag =
          typeof profile?.battle_tag === "string" ? profile.battle_tag : "unknown";

        const existing = await db.account.findFirst({
          where: {
            provider: "battlenet",
            providerAccountId: account.providerAccountId,
          },
        });

        // CASE 1 — already linked: sign in as the owner (switch if needed).
        if (existing) {
          if (!user?.id) {
            // Auth.js resolves `user` via adapter.getUserByAccount before this
            // callback; a missing id means a deleted-user race. Bail cleanly.
            logger.error(
              { battletag, accountUserId: existing.userId },
              "Battle.net sign-in aborted: adapter did not resolve a user",
            );
            return "/signin?error=Configuration";
          }
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
          logger.info(
            { battletag, userId: existing.userId },
            "Battle.net sign-in as linked user",
          );
          return true;
        }

        // Not linked yet — link-to-current vs auto-create depends on session.
        const current =
          (await (auth as unknown as () => Promise<Session | null>)()) ?? null;

        // CASE 2 — signed in: link Battle.net to the current user. Manual
        // create + redirect keeps the existing session (returning true here
        // would make the adapter mint a brand-new user instead of linking).
        if (current?.user?.id) {
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
                typeof account.session_state === "string"
                  ? account.session_state
                  : null,
            },
          });
          await audit({
            event: "AUTH_BATTLENET_LINKED",
            actorUserId: current.user.id,
            metadata: { battletag },
          });
          logger.info(
            { battletag, userId: current.user.id },
            "Battle.net linked to existing user",
          );
          return "/account?bnet=linked";
        }

        // CASE 3 — not linked, not signed in: REFUSE. Battle.net is link-only;
        // it must NOT create accounts. Battle.net exposes no email, so an
        // auto-created account is email-less — it can't be admin-by-email, has
        // no password to recover, and orphans the user's data. The user must
        // register with an email first, then link Battle.net from /account.
        logger.info(
          { battletag },
          "Battle.net sign-in refused: no linked account (link-only)",
        );
        return "/signin?error=BattlenetNoAccount";
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
      // On ANY Battle.net login, kick off background character/guild discovery.
      // Both the auto-create (CASE 3) and returning-login (CASE 1) paths reach
      // here; previously discovery ran ONLY client-side on the
      // /account?bnet=linked redirect (the manual-link path), so a plain
      // Battle.net login left the user with zero characters and "Resync" found
      // nothing. The job observes their characters/guilds, auto-joins guilds
      // (ACTIVE), and enqueues each character's first stat sync.
      // Fire-and-forget: a queue hiccup must never fail the login.
      if (account?.provider === "battlenet" && user.id) {
        try {
          const { enqueueBattlenetDiscover } = await import(
            "@/server/ingestion/jobs/battlenet-discover"
          );
          await enqueueBattlenetDiscover(user.id);
        } catch (err) {
          logger.warn(
            { err, userId: user.id },
            "battlenet discover enqueue on signIn failed",
          );
        }
      }
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
    async createUser({ user }) {
      // Fires when the wrapped adapter auto-creates a user — i.e. a Battle.net
      // first-time sign-up (credential signup creates its User directly in the
      // auth router, not via the adapter).
      await audit({
        event: "USER_CREATED",
        actorUserId: user.id,
        metadata: { via: "battlenet_oauth" },
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
