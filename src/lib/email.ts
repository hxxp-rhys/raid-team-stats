import { createHash } from "node:crypto";
import nodemailer, { type Transporter } from "nodemailer";
import { env } from "@/env";
import { logger } from "@/lib/logger";
import { redis } from "@/lib/redis";

/**
 * SMTP transport built once from env. In dev with no SMTP configured the
 * transport is a no-op that logs the message payload to the console (so the
 * verification flow can be exercised without a real mail server).
 *
 * Security: nodemailer 7.x has open advisories around `envelope.size` and
 * transport `name` injection. We never expose those fields to user input —
 * every callsite below builds the message from validated User rows and
 * server-controlled templates. See SECURITY.md for the full mitigation.
 */
type SendArgs = {
  to: string;
  subject: string;
  text: string;
  html?: string;
};

// Lazily resolved on first send. Building at module load would crash the
// Next.js build's page-data collection phase, which imports email.ts but
// doesn't actually call sendMail. `undefined` = not yet attempted; `null` =
// no SMTP configured (dev fallback applies).
let cachedTransporter: Transporter | null | undefined;

const getTransporter = (): Transporter | null => {
  if (cachedTransporter !== undefined) return cachedTransporter;
  if (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASSWORD) {
    if (env.NODE_ENV === "production") {
      throw new Error("SMTP_HOST, SMTP_USER, SMTP_PASSWORD are required in production");
    }
    cachedTransporter = null;
    return null;
  }
  cachedTransporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD },
  });
  return cachedTransporter;
};

const fromAddress = (): string => env.SMTP_FROM ?? "no-reply@localhost";

// Short-TTL dedupe window. Any identical send within this many seconds is
// treated as a duplicate and silently dropped. Covers the documented sources
// of double-emails on signup/reset: React's pre-`isPending` 1-frame window
// where a fast double-click can fire the mutation twice, and SMTP-side
// retries/relays. 15 s is short enough that a user who legitimately wants a
// fresh link (e.g. mistyped email) won't be blocked from re-requesting.
const EMAIL_DEDUPE_TTL_SECONDS = 15;

const dedupeKey = (args: SendArgs): string => {
  // Hash so an arbitrarily long URL/body never blows the Redis key cap, and
  // so we don't keep PII URLs as literal strings in cache. The (to + subject)
  // pair is the discriminator; we add the first 256 chars of `text` so two
  // *different* verify links to the same address (e.g. resend → fresh token)
  // are NOT collapsed into one.
  const hash = createHash("sha256")
    .update(args.to)
    .update("\0")
    .update(args.subject)
    .update("\0")
    .update(args.text.slice(0, 256))
    .digest("base64url");
  return `email:dedupe:${hash}`;
};

const sendMail = async (args: SendArgs): Promise<void> => {
  // Per-message dedupe, atomically claimed via SET NX EX. If the key already
  // exists the second caller gets `null` from SET — log it and bail. This is
  // the single choke point for every email leaving the system.
  try {
    const claimed = await redis.set(
      dedupeKey(args),
      "1",
      "EX",
      EMAIL_DEDUPE_TTL_SECONDS,
      "NX",
    );
    if (claimed === null) {
      logger.warn(
        { to: args.to, subject: args.subject },
        "email dedupe: identical message sent within window, dropping duplicate",
      );
      return;
    }
  } catch (err) {
    // Redis outage: fail-open. We'd rather risk a rare double-send than fail
    // the verification/reset flow outright.
    logger.error({ err, to: args.to, subject: args.subject }, "email dedupe lookup failed");
  }

  const transporter = getTransporter();
  if (!transporter) {
    // Dev fallback: render the email to logs so flows are inspectable.
    logger.info(
      { to: args.to, subject: args.subject, body: args.text },
      "dev mailer (no SMTP configured) — email NOT sent, payload logged",
    );
    return;
  }
  try {
    await transporter.sendMail({
      from: fromAddress(),
      to: args.to,
      subject: args.subject,
      text: args.text,
      html: args.html,
    });
  } catch (err) {
    // Never throw to the user-facing flow. The verify/reset tokens are stored
    // in the DB so a re-request is always possible.
    logger.error({ err, to: args.to, subject: args.subject }, "smtp send failed");
  }
};

export const sendVerificationEmail = async (
  to: string,
  verifyUrl: string,
): Promise<void> => {
  await sendMail({
    to,
    subject: `Verify your email — ${env.NEXT_PUBLIC_APP_NAME}`,
    text:
      `Welcome to ${env.NEXT_PUBLIC_APP_NAME}.\n\n` +
      `Open this link to verify your email address:\n\n${verifyUrl}\n\n` +
      `If you didn't sign up, ignore this email.\n`,
  });
};

export const sendPasswordResetEmail = async (
  to: string,
  resetUrl: string,
): Promise<void> => {
  await sendMail({
    to,
    subject: `Reset your password — ${env.NEXT_PUBLIC_APP_NAME}`,
    text:
      `Someone requested a password reset for your account.\n\n` +
      `Open this link to choose a new password:\n\n${resetUrl}\n\n` +
      `This link is valid for 1 hour. If you didn't request this, ignore the email.\n`,
  });
};
