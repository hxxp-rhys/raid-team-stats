import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Next 16 opt-in: explicit cache control via `'use cache'` instead of implicit fetch caching.
  // Required for `unstable_instant` validation; matches our snapshot/ingestion model.
  cacheComponents: true,

  // Disable the X-Powered-By header — also stripped in security/headers.ts as belt-and-braces.
  poweredByHeader: false,

  // Catch double-renders in dev that would mask state-management bugs.
  reactStrictMode: true,

  typedRoutes: true,

  // Optional standalone output for slim Docker images. Enable when wiring CI/CD.
  // output: "standalone",
};

export default nextConfig;
