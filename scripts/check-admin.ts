import { db } from "../src/lib/db";
import { emailBlindIndex } from "../src/server/auth/email-index";

async function main() {
  const indexes = ["nyhil116@gmail.com", "rhyscorgi@gmail.com"]
    .map((e) => emailBlindIndex(e))
    .filter((x): x is string => x != null);
  const users = await db.user.findMany({
    where: { emailIndex: { in: indexes } },
    select: { id: true, email: true, createdAt: true },
  });
  console.log("Users:", JSON.stringify(users, null, 2));
  console.log("ADMIN_USER_IDS env:", process.env.ADMIN_USER_IDS);
  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
