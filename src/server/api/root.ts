import { router } from "@/server/api/trpc";
import { accountRouter } from "@/server/api/routers/account";
import { adminRouter } from "@/server/api/routers/admin";
import { authRouter } from "@/server/api/routers/auth";
import { calendarRouter } from "@/server/api/routers/calendar";
import { dashboardRouter } from "@/server/api/routers/dashboard";
import { discordRouter } from "@/server/api/routers/discord";
import { guildRouter } from "@/server/api/routers/guild";
import { mfaRouter } from "@/server/api/routers/mfa";
import { monitoringRouter } from "@/server/api/routers/monitoring";
import { raidTeamRouter } from "@/server/api/routers/raidTeam";
import { recruitmentRouter } from "@/server/api/routers/recruitment";
import { snapshotRouter } from "@/server/api/routers/snapshot";
import { settingsRouter } from "@/server/api/routers/settings";
import { securityRouter } from "@/server/api/routers/security";

export const appRouter = router({
  account: accountRouter,
  admin: adminRouter,
  auth: authRouter,
  calendar: calendarRouter,
  discord: discordRouter,
  guild: guildRouter,
  mfa: mfaRouter,
  monitoring: monitoringRouter,
  raidTeam: raidTeamRouter,
  recruitment: recruitmentRouter,
  snapshot: snapshotRouter,
  dashboard: dashboardRouter,
  settings: settingsRouter,
  security: securityRouter,
});

export type AppRouter = typeof appRouter;
