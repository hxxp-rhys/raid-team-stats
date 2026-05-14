import { router } from "@/server/api/trpc";
import { authRouter } from "@/server/api/routers/auth";
import { raidTeamRouter } from "@/server/api/routers/raidTeam";

export const appRouter = router({
  auth: authRouter,
  raidTeam: raidTeamRouter,
});

export type AppRouter = typeof appRouter;
