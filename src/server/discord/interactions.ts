import { db } from "@/lib/db";
import { env } from "@/env";
import { logger } from "@/lib/logger";
import { InteractionType, STATE_GLYPH } from "@/lib/discord/constants";
import { decodeRoute, type AttendanceState } from "@/lib/discord/custom-id";
import {
  ephemeral,
  etaModal,
  linkPrompt,
  pong,
  reasonModal,
} from "@/lib/discord/responses";
import { intentKey } from "@/server/calendar/sync";
import { applySignupIntent, type SignupState } from "@/server/calendar/signup-intent";
import { consumeLinkCode, resolveDiscordUserId } from "@/server/discord/link";

/**
 * Pure-ish interaction dispatcher. Takes the already-verified interaction
 * payload, resolves the signed Discord user → site account → team character,
 * applies the signup through the shared intent service, and returns the <3s
 * response object. The public embed is re-rendered LATER by the fan-out relay
 * (Discord stores nothing authoritative).
 */

type DiscordUser = { id: string };
type Interaction = {
  id: string;
  type: number;
  token?: string;
  member?: { user?: DiscordUser };
  user?: DiscordUser;
  guild_id?: string;
  channel_id?: string;
  data?: {
    name?: string;
    custom_id?: string;
    options?: { name: string; value?: string; options?: { name: string; value?: string }[] }[];
    components?: { components?: { custom_id?: string; value?: string }[] }[];
  };
};

const STATE_LABEL: Record<AttendanceState, string> = {
  CONFIRM: "Confirmed",
  TENTATIVE: "Tentative",
  LATE: "Late",
  ABSENT: "Absent",
};

const accountUrl = () => `${env.APP_URL}/account`;

/** First active character for a user on a team (or null). */
async function resolveMemberCharacter(
  userId: string,
  raidTeamId: string,
): Promise<string | null> {
  const m = await db.raidTeamMembership.findFirst({
    where: { raidTeamId, isActive: true, character: { userId } },
    select: { characterId: true },
    orderBy: { id: "asc" },
  });
  return m?.characterId ?? null;
}

/** Apply an attendance state from a Discord interaction and build the ack. */
async function applyAndAck(
  snowflake: string,
  interactionId: string,
  eventId: string,
  state: SignupState,
  extras: { etaMinutes?: number | null; reason?: string | null },
): Promise<unknown> {
  const userId = await resolveDiscordUserId(db, snowflake);
  if (!userId) return linkPrompt(accountUrl());

  const event = await db.raidEvent.findUnique({
    where: { id: eventId },
    select: { raidTeamId: true },
  });
  if (!event) return ephemeral("That raid no longer exists.");

  const characterId = await resolveMemberCharacter(userId, event.raidTeamId);
  if (!characterId) {
    return ephemeral("You don't have a character on this raid team.");
  }

  // Idempotent per interaction id — a Discord re-delivery of the same tap is a
  // no-op (idempotencyKey is stable for the interaction).
  const key = intentKey(userId, eventId, `discord:${interactionId}`);
  const result = await applySignupIntent(db, {
    userId,
    eventId,
    characterId,
    state,
    etaMinutes: extras.etaMinutes ?? null,
    reason: extras.reason ?? null,
    source: "DISCORD",
    idempotencyKey: key,
    updatedByUserId: userId,
  });

  if (!result.ok) {
    const msg =
      result.reason === "past"
        ? "This raid has already finished."
        : result.reason === "cancelled"
          ? "This raid was cancelled."
          : result.reason === "not_member"
            ? "You don't have a character on this raid team."
            : "That raid no longer exists.";
    return ephemeral(msg);
  }

  const glyph = STATE_GLYPH[state] ?? "";
  const eta =
    state === "LATE" && extras.etaMinutes != null ? ` (~${extras.etaMinutes}m)` : "";
  return ephemeral(`${glyph} You're marked **${STATE_LABEL[state]}**${eta}. The board updates in a few seconds.`);
}

async function handleComponent(interaction: Interaction, snowflake: string) {
  const route = decodeRoute(interaction.data?.custom_id ?? "");
  if (!route) return ephemeral("Sorry, that button is no longer valid.");
  if (route.kind === "att") {
    if (route.state === "LATE") return etaModal(route.eventId);
    if (route.state === "ABSENT") return reasonModal(route.eventId);
    return applyAndAck(snowflake, interaction.id, route.eventId, route.state, {});
  }
  if (route.kind === "refresh") {
    // The board re-renders automatically off the outbox; nothing to apply here.
    return ephemeral("The signup board refreshes automatically after each change.");
  }
  return ephemeral("Unsupported action.");
}

async function handleModal(interaction: Interaction, snowflake: string) {
  const route = decodeRoute(interaction.data?.custom_id ?? "");
  if (!route) return ephemeral("That form is no longer valid.");
  const value =
    interaction.data?.components?.[0]?.components?.[0]?.value?.trim() ?? "";

  if (route.kind === "eta") {
    const digits = value.match(/\d+/)?.[0];
    const minutes = digits ? Math.min(600, Math.max(0, Number(digits))) : 0;
    return applyAndAck(snowflake, interaction.id, route.eventId, "LATE", { etaMinutes: minutes });
  }
  if (route.kind === "reason") {
    return applyAndAck(snowflake, interaction.id, route.eventId, "ABSENT", {
      reason: value || null,
    });
  }
  return ephemeral("Unsupported form.");
}

async function handleCommand(interaction: Interaction, snowflake: string) {
  const name = interaction.data?.name;
  if (name === "statsmith") {
    const sub = interaction.data?.options?.[0];
    if (sub?.name === "link") {
      const code = sub.options?.find((o) => o.name === "code")?.value ?? "";
      if (!code) return ephemeral("Provide the code from your account page.");
      const res = await consumeLinkCode(db, code, snowflake);
      if (res.ok) {
        return ephemeral(
          res.alreadyLinked
            ? "Your Discord is already linked to your Stat Smith account. ✅"
            : "Linked! Your taps here now sign you up. ✅",
        );
      }
      const msg =
        res.reason === "expired"
          ? "That code expired — generate a fresh one on your account page."
          : res.reason === "used"
            ? "That code was already used — generate a fresh one."
            : res.reason === "snowflake_taken"
              ? "This Discord account is already linked to a different Stat Smith account."
              : "That code isn't valid — check it and try again.";
      return ephemeral(msg);
    }
    return ephemeral("Unknown command.");
  }
  return ephemeral("Unknown command.");
}

export async function handleInteraction(interaction: Interaction): Promise<unknown> {
  try {
    if (interaction.type === InteractionType.PING) return pong();

    const snowflake = interaction.member?.user?.id ?? interaction.user?.id ?? null;
    if (!snowflake) return ephemeral("Couldn't identify your Discord account.");

    switch (interaction.type) {
      case InteractionType.MESSAGE_COMPONENT:
        return await handleComponent(interaction, snowflake);
      case InteractionType.MODAL_SUBMIT:
        return await handleModal(interaction, snowflake);
      case InteractionType.APPLICATION_COMMAND:
        return await handleCommand(interaction, snowflake);
      default:
        return ephemeral("Unsupported interaction.");
    }
  } catch (err) {
    logger.error({ err, type: interaction.type }, "discord interaction handler failed");
    return ephemeral("Something went wrong handling that — try again in a moment.");
  }
}
