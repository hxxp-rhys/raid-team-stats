import { createHash } from "node:crypto";

import type { Prisma } from "@/generated/prisma/client";
import type { ExtendedPrismaClient } from "@/lib/db";

/**
 * The interactive-transaction client type for our EXTENDED Prisma client —
 * what `db.$transaction(async (tx) => …)` hands the callback. Derived from the
 * extended client so it matches at the call sites (the stock
 * `Prisma.TransactionClient` does not, because the client is `$extends`-ed).
 */
export type CalendarTx = Omit<
  ExtendedPrismaClient,
  "$connect" | "$disconnect" | "$on" | "$use" | "$transaction" | "$extends"
>;

/**
 * Sync primitives for the raid calendar. The website is the single source of
 * truth: every mutation writes the authoritative row AND a SyncOutbox row in
 * ONE transaction (no dual-write). Browsers read the outbox via a polled tRPC
 * query keyed on the row id (the ordering); the Discord + companion fan-out
 * consumers (later phases) drain PENDING rows and advance their own cursors.
 */

export type OutboxKind =
  | "event.created"
  | "event.updated"
  | "event.cancelled"
  | "signup.changed";

/**
 * Append one outbox row inside an existing transaction. `idempotencyKey` lets a
 * consumer dedupe; `version` is the event/signup version this slice carries.
 * Returns the new row id (BigInt) — the cursor value clients advance past.
 */
export async function appendOutbox(
  tx: CalendarTx,
  args: {
    raidTeamId: string;
    raidEventId?: string | null;
    kind: OutboxKind;
    payload: Prisma.InputJsonValue;
    version: number;
    idempotencyKey: string;
  },
): Promise<bigint> {
  const row = await tx.syncOutbox.create({
    data: {
      raidTeamId: args.raidTeamId,
      raidEventId: args.raidEventId ?? null,
      kind: args.kind,
      payload: args.payload,
      version: args.version,
      idempotencyKey: args.idempotencyKey,
    },
    select: { id: true },
  });
  return row.id;
}

/** Stable idempotency key for an intent. */
export function intentKey(
  userId: string,
  eventId: string,
  clientActionId: string,
): string {
  return createHash("sha256")
    .update(`${userId}:${eventId}:${clientActionId}`)
    .digest("hex");
}

/** Random idempotency key for a server-originated change (web mutation). */
export function serverActionKey(): string {
  return createHash("sha256")
    .update(`srv:${cryptoRandom()}`)
    .digest("hex")
    .slice(0, 40);
}

// Small wrapper so the one Math.random-free path is centralized; server
// actions don't need cryptographic randomness, just uniqueness within a tx.
let _counter = 0;
function cryptoRandom(): string {
  _counter = (_counter + 1) % Number.MAX_SAFE_INTEGER;
  return `${process.pid}:${_counter}:${process.hrtime.bigint().toString()}`;
}
