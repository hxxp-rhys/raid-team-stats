import { db } from "../src/lib/db";
import { emailBlindIndex } from "../src/server/auth/email-index";

async function main() {
  const emails = (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (emails.length === 0) {
    console.log("No ADMIN_EMAILS env set — nothing to promote.");
    return;
  }
  // Email is encrypted at rest; match on the blind index instead.
  const indexes = emails
    .map((e) => emailBlindIndex(e))
    .filter((x): x is string => x != null);
  const updated = await db.user.updateMany({
    where: { emailIndex: { in: indexes }, isAdmin: false },
    data: { isAdmin: true },
  });
  console.log(`Promoted ${updated.count} user(s) to isAdmin=true.`);
  const all = await db.user.findMany({
    where: { isAdmin: true },
    select: { id: true, email: true, isAdmin: true },
  });
  console.log("All current admins:", all);
  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
