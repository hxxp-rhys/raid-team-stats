import { env } from "@/env";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { sendRecruitmentNotificationEmail } from "@/lib/email";
import { isDiscordEnabled } from "@/lib/discord/config";
import { createDmChannel, postMessage } from "@/lib/discord/rest";

/**
 * Recruitment notification sweep — drains RecruitmentNotificationOutbox and
 * messages reviewers who OPTED IN (a RecruitmentNotificationPref row), by their
 * chosen channel (EMAIL or DISCORD_DM). Notifications are strictly opt-in: a
 * reviewer with no pref row is never messaged. Per-form prefs only (a pref is
 * created via the officer-gated setNotificationPref, so a formId-scoped pref
 * proves the user may review that form — no cross-guild leak).
 *
 * Mirrors the calendar fan-out pattern: a single in-process lock, bounded
 * batch, per-row attempt counter, processedAt stamp = exactly-once-ish.
 */

const MAX_BATCH = 20;
const MAX_ATTEMPTS = 5;
let running = false;

export async function runRecruitmentNotificationSweep(): Promise<{
  processed: number;
}> {
  if (running) return { processed: 0 };
  running = true;
  try {
    const rows = await db.recruitmentNotificationOutbox.findMany({
      where: { processedAt: null, attempts: { lt: MAX_ATTEMPTS } },
      orderBy: { createdAt: "asc" },
      take: MAX_BATCH,
    });
    let processed = 0;
    for (const row of rows) {
      try {
        await deliverOne(row.submissionId, row.kind);
        await db.recruitmentNotificationOutbox.update({
          where: { id: row.id },
          data: { processedAt: new Date() },
        });
        processed++;
      } catch (err) {
        logger.warn(
          { err, id: row.id },
          "recruit notify: delivery failed (will retry)",
        );
        await db.recruitmentNotificationOutbox
          .update({
            where: { id: row.id },
            data: { attempts: { increment: 1 } },
          })
          .catch(() => {});
      }
    }
    return { processed };
  } finally {
    running = false;
  }
}

async function deliverOne(
  submissionId: string,
  kind: "NEW_SUBMISSION" | "STATUS_CHANGE" | "QUORUM_REACHED",
): Promise<void> {
  const sub = await db.formSubmission.findUnique({
    where: { id: submissionId },
    select: {
      id: true,
      applicantLabel: true,
      status: true,
      form: { select: { id: true, name: true, guildId: true } },
    },
  });
  if (!sub) return; // submission deleted — treat as delivered

  const form = sub.form;
  const applicantLabel = sub.applicantLabel ?? "An applicant";
  const reviewUrl = `${env.APP_URL}/guild/${form.guildId}/recruitment/${form.id}?submission=${sub.id}`;
  const emailKind = kind === "NEW_SUBMISSION" ? "new" : "status";

  // Match prefs to the event kind. Per-form prefs only (officer-verified).
  const kindWhere =
    kind === "NEW_SUBMISSION"
      ? { onNew: true }
      : kind === "STATUS_CHANGE"
        ? { onStatusChange: true }
        : { onQuorum: true };
  const prefs = await db.recruitmentNotificationPref.findMany({
    where: { formId: form.id, ...kindWhere },
    select: {
      userId: true,
      channel: true,
      user: { select: { email: true } },
    },
  });

  const seen = new Set<string>();
  for (const p of prefs) {
    const key = `${p.userId}|${p.channel}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (p.channel === "EMAIL") {
      if (!p.user.email) continue;
      await sendRecruitmentNotificationEmail({
        to: p.user.email,
        formName: form.name,
        applicantLabel,
        kind: emailKind,
        statusLabel: sub.status,
        reviewUrl,
      });
    } else if (p.channel === "DISCORD_DM") {
      if (!isDiscordEnabled()) continue;
      const acct = await db.account.findFirst({
        where: { userId: p.userId, provider: "discord" },
        select: { providerAccountId: true },
      });
      if (!acct) continue;
      const dm = await createDmChannel(acct.providerAccountId);
      if (!dm.ok || !dm.data?.id) continue;
      const verb =
        kind === "NEW_SUBMISSION" ? "new application" : "status update";
      await postMessage(dm.data.id, {
        content: `**${form.name}** — ${verb}: ${applicantLabel}\n${reviewUrl}`,
      });
    }
  }
}
