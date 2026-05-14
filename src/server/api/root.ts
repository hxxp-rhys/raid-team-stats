import { router } from "@/server/api/trpc";
import { authRouter } from "@/server/api/routers/auth";
import { guildRouter } from "@/server/api/routers/guild";
import { raidTeamRouter } from "@/server/api/routers/raidTeam";

export const appRouter = router({
  auth: authRouter,
  guild: guildRouter,
  raidTeam: raidTeamRouter,
});

export type AppRouter = typeof appRouter;
