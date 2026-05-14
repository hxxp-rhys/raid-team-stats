import nodemailer, { type Transporter } from "nodemailer";
import { env } from "@/env";
import { logger } from "@/lib/logger";

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

const buildTransport = (): Transporter | null => {
  if (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASSWORD) {
    if (env.NODE_ENV === "production") {
      throw new Error("SMTP_HOST, SMTP_USER, SMTP_PASSWORD are required in production");
    }
    return null;
  }
  return nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD },
  });
};

const transporter = buildTransport();
const fromAddress = env.SMTP_FROM ?? "no-reply@localhost";

const sendMail = async (args: SendArgs): Promise<void> => {
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
      from: fromAddress,
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
