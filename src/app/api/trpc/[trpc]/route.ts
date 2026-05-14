import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter } from "@/server/api/root";
import { createContext } from "@/server/api/trpc";
import { logger } from "@/lib/logger";

const handler = (request: Request) =>
  fetchRequestHandler({
    endpoint: "/api/trpc",
    req: request,
    router: appRouter,
    createContext,
    onError({ path, error, type }) {
      logger.error({ path, type, code: error.code, err: error }, "trpc handler error");
    },
  });

export { handler as GET, handler as POST };
