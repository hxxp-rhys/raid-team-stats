import { router } from "@/server/api/trpc";
import { authRouter } from "@/server/api/routers/auth";

export const appRouter = router({
  auth: authRouter,
});

export type AppRouter = typeof appRouter;
