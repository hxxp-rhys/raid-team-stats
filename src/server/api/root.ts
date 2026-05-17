import { router } from "@/server/api/trpc";
import { accountRouter } from "@/server/api/routers/account";
import { adminRouter } from "@/server/api/routers/admin";
import { authRouter } from "@/server/api/routers/auth";
import { dashboardRouter } from "@/server/api/routers/dashboard";
import { guildRouter } from "@/server/api/routers/guild";
import { mfaRouter } from "@/server/api/routers/mfa";
import { raidTeamRouter } from "@/server/api/routers/raidTeam";
import { snapshotRouter } from "@/server/api/routers/snapshot";

export const appRouter = router({
  account: accountRouter,
  admin: adminRouter,
  auth: authRouter,
  guild: guildRouter,
  mfa: mfaRouter,
  raidTeam: raidTeamRouter,
  snapshot: snapshotRouter,
  dashboard: dashboardRouter,
});

export type AppRouter = typeof appRouter;
