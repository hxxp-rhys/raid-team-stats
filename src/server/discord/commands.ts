import { putGuildCommands } from "@/lib/discord/rest";

/**
 * Slash-command definitions + per-guild registrar. We register GUILD commands
 * (instant) rather than global (~1h propagation) when a team binds its Discord.
 * v1 ships just account-linking; /raid create + /statsmith setup can follow
 * (event creation already auto-posts the embed from the website, so they're a
 * convenience, not a dependency).
 */

const SUB_COMMAND = 1;
const OPTION_STRING = 3;

export const STATSMITH_COMMANDS = [
  {
    name: "statsmith",
    description: "Raid Team Stats raid tools",
    options: [
      {
        type: SUB_COMMAND,
        name: "link",
        description: "Link your Discord to your Raid Team Stats account",
        options: [
          {
            type: OPTION_STRING,
            name: "code",
            description: "The link code from your Raid Team Stats account page",
            required: true,
          },
        ],
      },
    ],
  },
];

/** Register (bulk-overwrite) the guild's slash commands. */
export async function registerGuildCommands(
  guildId: string,
): Promise<{ ok: boolean; error?: string }> {
  const res = await putGuildCommands(guildId, STATSMITH_COMMANDS);
  return res.ok ? { ok: true } : { ok: false, error: `${res.status}: ${res.error}` };
}
