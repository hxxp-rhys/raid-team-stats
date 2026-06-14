/** Discord interaction + response type numbers, component shapes, flags. */

export const InteractionType = {
  PING: 1,
  APPLICATION_COMMAND: 2,
  MESSAGE_COMPONENT: 3,
  APPLICATION_COMMAND_AUTOCOMPLETE: 4,
  MODAL_SUBMIT: 5,
} as const;

export const InteractionResponseType = {
  PONG: 1,
  CHANNEL_MESSAGE_WITH_SOURCE: 4, // ephemeral ack uses this + flags 64
  DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5,
  // 6 DEFERRED_UPDATE_MESSAGE — intentionally unused (M1); see discord-api skill.
  UPDATE_MESSAGE: 7,
  APPLICATION_COMMAND_AUTOCOMPLETE_RESULT: 8,
  MODAL: 9,
} as const;

export const MessageFlags = {
  EPHEMERAL: 1 << 6, // 64
} as const;

export const ComponentType = {
  ACTION_ROW: 1,
  BUTTON: 2,
  STRING_SELECT: 3,
  TEXT_INPUT: 4,
} as const;

export const ButtonStyle = {
  PRIMARY: 1, // blurple
  SECONDARY: 2, // grey
  SUCCESS: 3, // green
  DANGER: 4, // red
  LINK: 5, // url, no custom_id
} as const;

export const TextInputStyle = {
  SHORT: 1,
  PARAGRAPH: 2,
} as const;

/** Attendance state ↔ glyph/colour, mirrored from the website parts. */
export const STATE_GLYPH: Record<string, string> = {
  CONFIRM: "✅",
  TENTATIVE: "🟡",
  LATE: "🕒",
  ABSENT: "❌",
  NO_RESPONSE: "⬜",
};

/** Embed left-bar colour by difficulty (decimal RGB). */
export const DIFFICULTY_COLOR: Record<string, number> = {
  Mythic: 0xf97316, // orange
  Heroic: 0xa855f7, // purple
  Normal: 0x0ea5e9, // sky
  LFR: 0x71717a, // zinc
};
