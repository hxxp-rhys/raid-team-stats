"use client";

import { createTRPCReact } from "@trpc/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@/server/api/root";

export const api = createTRPCReact<AppRouter>();

/** Inferred output types for every procedure, e.g.
 *  `RouterOutputs["guild"]["discoverGuildCandidates"]`. */
export type RouterOutputs = inferRouterOutputs<AppRouter>;
