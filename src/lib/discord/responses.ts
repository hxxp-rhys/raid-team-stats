import {
  ButtonStyle,
  ComponentType,
  InteractionResponseType,
  MessageFlags,
  TextInputStyle,
} from "./constants";
import { encodeRoute } from "./custom-id";

/** Interaction-response builders (pure). The <3s reply to a Discord webhook. */

export function pong() {
  return { type: InteractionResponseType.PONG };
}

/** Ephemeral message (only the tapper sees it). flags 64 = EPHEMERAL. */
export function ephemeral(content: string, components?: unknown[]) {
  return {
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      content,
      flags: MessageFlags.EPHEMERAL,
      ...(components ? { components } : {}),
    },
  };
}

/** LATE → modal asking for an ETA (opening a modal is a valid <3s response). */
export function etaModal(eventId: string) {
  return {
    type: InteractionResponseType.MODAL,
    data: {
      custom_id: encodeRoute({ kind: "eta", eventId }),
      title: "How late will you be?",
      components: [
        {
          type: ComponentType.ACTION_ROW,
          components: [
            {
              type: ComponentType.TEXT_INPUT,
              custom_id: "eta",
              style: TextInputStyle.SHORT,
              label: "Minutes late",
              placeholder: "e.g. 20",
              required: true,
              max_length: 5,
            },
          ],
        },
      ],
    },
  };
}

/** ABSENT → modal with an OPTIONAL reason (empty submit = plain absent). */
export function reasonModal(eventId: string) {
  return {
    type: InteractionResponseType.MODAL,
    data: {
      custom_id: encodeRoute({ kind: "reason", eventId }),
      title: "Marking yourself Absent",
      components: [
        {
          type: ComponentType.ACTION_ROW,
          components: [
            {
              type: ComponentType.TEXT_INPUT,
              custom_id: "reason",
              style: TextInputStyle.PARAGRAPH,
              label: "Reason (optional)",
              placeholder: "e.g. work, will be back next week",
              required: false,
              max_length: 300,
            },
          ],
        },
      ],
    },
  };
}

/** Unlinked user → ephemeral prompt with a link-to-website button. */
export function linkPrompt(accountUrl: string) {
  return ephemeral(
    "Link your Raid Team Stats account first, then your taps here sign you up. Open your account page to get a link code.",
    [
      {
        type: ComponentType.ACTION_ROW,
        components: [
          {
            type: ComponentType.BUTTON,
            style: ButtonStyle.LINK,
            label: "Link my account",
            url: accountUrl,
          },
        ],
      },
    ],
  );
}
