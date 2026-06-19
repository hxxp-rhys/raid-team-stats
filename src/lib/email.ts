import { createHash } from "node:crypto";
import nodemailer, { type Transporter } from "nodemailer";
import { env } from "@/env";
import { siteConfig } from "@/lib/site-config";
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
    subject: `Verify your email — ${siteConfig.appName}`,
    text:
      `Welcome to ${siteConfig.appName}.\n\n` +
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
    subject: `Reset your password — ${siteConfig.appName}`,
    text:
      `Someone requested a password reset for your account.\n\n` +
      `Open this link to choose a new password:\n\n${resetUrl}\n\n` +
      `This link is valid for 1 hour. If you didn't request this, ignore the email.\n`,
  });
};

/**
 * Raid auto-reminder. Two audiences: people who are GOING get a "raid soon"
 * nudge; non-responders get a "please sign up" prompt. The exactly-once
 * guarantee lives in the SentReminder ledger upstream — this only renders and
 * sends. Times are formatted in the team's own timezone.
 */
export const sendRaidReminderEmail = async (args: {
  to: string;
  teamName: string;
  title: string;
  startsAt: Date;
  timezone: string;
  audience: "going" | "no-response";
  eventUrl: string;
}): Promise<void> => {
  let whenLocal: string;
  try {
    whenLocal = new Intl.DateTimeFormat("en-GB", {
      timeZone: args.timezone,
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    }).format(args.startsAt);
  } catch {
    whenLocal = args.startsAt.toISOString();
  }
  const isNudge = args.audience === "no-response";
  const subject = isNudge
    ? `Please sign up: ${args.title} — ${args.teamName}`
    : `Reminder: ${args.title} — ${whenLocal}`;
  const lead = isNudge
    ? `You haven't responded to an upcoming raid yet — let your team know if you can make it.`
    : `This is a reminder for your upcoming raid.`;
  await sendMail({
    to: args.to,
    subject,
    text:
      `${lead}\n\n` +
      `${args.title} — ${args.teamName}\n` +
      `When: ${whenLocal} (${args.timezone})\n\n` +
      `Set your attendance here:\n${args.eventUrl}\n`,
  });
};

/**
 * Recruitment: notify an opted-in reviewer about a new application (or a
 * status change). Reuses the single sendMail choke point + dedupe.
 */
export const sendRecruitmentNotificationEmail = async (args: {
  to: string;
  formName: string;
  applicantLabel: string;
  kind: "new" | "status";
  statusLabel?: string;
  reviewUrl: string;
}): Promise<void> => {
  const subject =
    args.kind === "new"
      ? `New application: ${args.applicantLabel} — ${args.formName}`
      : `Application ${args.statusLabel ?? "updated"}: ${args.applicantLabel} — ${args.formName}`;
  const lead =
    args.kind === "new"
      ? `A new application was submitted to "${args.formName}".`
      : `An application to "${args.formName}" is now ${args.statusLabel ?? "updated"}.`;
  await sendMail({
    to: args.to,
    subject,
    text:
      `${lead}\n\n` +
      `Applicant: ${args.applicantLabel}\n\n` +
      `Review it here:\n${args.reviewUrl}\n`,
  });
};

/**
 * Notify a user that a newer version of the desktop companion uploader is
 * available. Sent best-effort from the ingest hook (the upload still succeeds
 * regardless). Routes through the single sendMail choke point (Redis dedupe,
 * never throws).
 */
export const sendCompanionUpdateEmail = async (args: {
  to: string;
  currentVersion: string;
  latestVersion: string;
  installerUrl: string;
}): Promise<void> => {
  const accountUrl = `${env.APP_URL}/account`;
  await sendMail({
    to: args.to,
    subject: `Companion update available — ${siteConfig.appName}`,
    text:
      `A new version of the ${siteConfig.appName} companion uploader is available.\n\n` +
      `Your version: ${args.currentVersion}\n` +
      `Latest version: ${args.latestVersion}\n\n` +
      `Download the latest installer here:\n${args.installerUrl}\n\n` +
      `Or manage your account and uploader here:\n${accountUrl}\n\n` +
      `Updating keeps your uploads working as the site evolves.\n`,
    html:
      `<p>A new version of the <strong>${siteConfig.appName}</strong> companion uploader is available.</p>` +
      `<p>Your version: <strong>${args.currentVersion}</strong><br/>` +
      `Latest version: <strong>${args.latestVersion}</strong></p>` +
      `<p><a href="${args.installerUrl}">Download the latest installer</a> ` +
      `or <a href="${accountUrl}">manage your account and uploader</a>.</p>` +
      `<p>Updating keeps your uploads working as the site evolves.</p>`,
  });
};
