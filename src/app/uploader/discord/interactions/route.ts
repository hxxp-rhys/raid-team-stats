import { NextResponse } from "next/server";

import { logger } from "@/lib/logger";
import { discordConfig } from "@/lib/discord/config";
import { verifyInteractionSignature } from "@/lib/discord/verify";
import { MessageFlags, InteractionResponseType } from "@/lib/discord/constants";
import { handleInteraction } from "@/server/discord/interactions";

/**
 * Discord HTTP Interactions endpoint. Under /uploader/* so a new path doesn't
 * hit Cloudflare's edge-cached /api 404 (purge CF once after deploy). Verifies
 * the Ed25519 signature over the RAW body (the auth boundary — we MUST read
 * req.text() not req.json()), answers PING with PONG, and dispatches everything
 * else to the handler. A bad/absent signature → 401 (Discord's routine
 * invalid-signature probes expect this; it must not read as an outage).
 */

const MAX_BODY = 256 * 1024;

export async function POST(req: Request) {
  const cfg = discordConfig();
  if (!cfg) {
    return NextResponse.json({ error: "discord not configured" }, { status: 503 });
  }

  const signature = req.headers.get("x-signature-ed25519");
  const timestamp = req.headers.get("x-signature-timestamp");

  // Raw body (NOT req.json()): a re-serialization changes the bytes the
  // signature was computed over.
  const rawBody = await req.text();
  if (rawBody.length > MAX_BODY) {
    return new NextResponse("payload too large", { status: 413 });
  }

  if (!verifyInteractionSignature(rawBody, signature, timestamp, cfg.publicKey)) {
    return new NextResponse("invalid request signature", { status: 401 });
  }

  let interaction: unknown;
  try {
    interaction = JSON.parse(rawBody);
  } catch {
    return new NextResponse("bad request", { status: 400 });
  }

  try {
    const response = await handleInteraction(interaction as never);
    return NextResponse.json(response);
  } catch (err) {
    logger.error({ err }, "discord interactions route failed");
    // Signature already verified — answer with an ephemeral error rather than a
    // 500 so the user's client doesn't show "interaction failed".
    return NextResponse.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: "Something went wrong — try again.", flags: MessageFlags.EPHEMERAL },
    });
  }
}
