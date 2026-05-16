import { db } from "../src/lib/db";

async function main() {
  const users = await db.user.findMany({
    where: { email: { in: ["nyhil116@gmail.com", "rhyscorgi@gmail.com"] } },
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
