import { db } from "../src/lib/db";

async function main() {
  const [guilds, users, characters, memberships] = await Promise.all([
    db.guild.count(),
    db.user.count(),
    db.character.count(),
    db.guildMembership.count(),
  ]);
  console.log(JSON.stringify({ guilds, users, characters, memberships }));
  await db.$disconnect();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
