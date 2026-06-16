/**
 * One-time backfill: encrypt PII rows that predate the transparent field
 * encryption (F11). Re-saves each row through the encrypting Prisma client, so
 * already-encrypted rows are a no-op (idempotent) and legacy plaintext rows get
 * encrypted in place. Safe to re-run.
 *
 *   docker compose exec web npx tsx scripts/backfill-pii-encryption.ts
 *
 * NB: `email` is intentionally NOT covered yet (it's the @unique login key and
 * needs the blind-index migration first). All other PII is handled here.
 */
import { db } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";

async function backfill() {
  let users = 0;
  let subs = 0;
  let answers = 0;

  const allUsers = await db.user.findMany({
    select: { id: true, displayName: true, avatarUrl: true },
  });
  for (const u of allUsers) {
    if (u.displayName == null && u.avatarUrl == null) continue;
    const data: { displayName?: string; avatarUrl?: string } = {};
    if (u.displayName != null) data.displayName = u.displayName;
    if (u.avatarUrl != null) data.avatarUrl = u.avatarUrl;
    await db.user.update({ where: { id: u.id }, data });
    users++;
  }

  const allSubs = await db.formSubmission.findMany({
    select: { id: true, answersJson: true, applicantLabel: true },
  });
  for (const s of allSubs) {
    await db.formSubmission.update({
      where: { id: s.id },
      data: {
        answersJson: s.answersJson as Prisma.InputJsonValue,
        ...(s.applicantLabel != null ? { applicantLabel: s.applicantLabel } : {}),
      },
    });
    subs++;
  }

  const allAnswers = await db.formAnswer.findMany({
    select: { id: true, valueText: true, valueJson: true },
  });
  for (const a of allAnswers) {
    const data: { valueText?: string; valueJson?: Prisma.InputJsonValue } = {};
    if (a.valueText != null) data.valueText = a.valueText;
    if (a.valueJson != null) data.valueJson = a.valueJson as Prisma.InputJsonValue;
    if (Object.keys(data).length === 0) continue;
    await db.formAnswer.update({ where: { id: a.id }, data });
    answers++;
  }

  console.log(
    `PII backfill complete: ${users} users, ${subs} submissions, ${answers} answers re-saved (encrypted).`,
  );
}

backfill()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
