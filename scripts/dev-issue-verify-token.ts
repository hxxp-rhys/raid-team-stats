/**
 * Dev/test utility: issue a verify-email or password-reset token for a given
 * user without triggering an SMTP send. Prints the raw token to stdout so a
 * tester can paste it into the /verify or /reset/confirm URL.
 *
 * Usage (inside the web container):
 *   docker exec rts-web npx tsx scripts/dev-issue-verify-token.ts verify_email user@example.com
 *   docker exec rts-web npx tsx scripts/dev-issue-verify-token.ts password_reset user@example.com
 *
 * Refuses to run in production. Never reaches end users — this is a local-only
 * shortcut around the email round-trip for smoke testing.
 */

import { db } from "@/lib/db";
import { emailBlindIndex } from "@/server/auth/email-index";
import { issueToken, buildVerifyUrl, buildResetUrl } from "@/server/auth/tokens";

async function main() {
  if (process.env.NODE_ENV === "production") {
    console.error("Refusing to run in production");
    process.exit(2);
  }

  const [kind, email] = process.argv.slice(2);
  if (!kind || !email) {
    console.error("Usage: dev-issue-verify-token.ts <verify_email|password_reset> <email>");
    process.exit(2);
  }
  if (kind !== "verify_email" && kind !== "password_reset") {
    console.error(`Unknown kind: ${kind}`);
    process.exit(2);
  }

  const idx = emailBlindIndex(email);
  const user = idx
    ? await db.user.findUnique({
        where: { emailIndex: idx },
        select: { id: true, email: true },
      })
    : null;
  if (!user) {
    console.error(`No user found for ${email}`);
    process.exit(1);
  }

  const { raw, expiresAt } = await issueToken(kind, user.id);
  const url = kind === "verify_email" ? buildVerifyUrl(raw) : buildResetUrl(raw);

  console.log(`User: ${user.email} (${user.id})`);
  console.log(`Kind: ${kind}`);
  console.log(`Raw token: ${raw}`);
  console.log(`Expires: ${expiresAt.toISOString()}`);
  console.log(`URL: ${url}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => process.exit(0));
