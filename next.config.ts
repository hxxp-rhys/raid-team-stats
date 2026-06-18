import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Cache Components (cacheComponents / PPR) is intentionally NOT enabled. It is
  // incompatible with our strict nonce-based CSP: PPR serves a statically
  // prerendered shell whose framework/chunk <script> tags carry no per-request
  // nonce, so `script-src 'strict-dynamic'` blocks them and the app never
  // hydrates (every onClick is dead, zero network on click). A per-request nonce
  // REQUIRES dynamic rendering — which is free here (the app caches nothing via
  // `'use cache'`; data is client-side React Query). If you ever adopt
  // `'use cache'`, turn on `experimental.useCache` ONLY (never cacheComponents),
  // so PPR's static shell stays off. See src/server/security/csp.ts + src/proxy.ts.

  // Disable the X-Powered-By header — also stripped in security/headers.ts as belt-and-braces.
  poweredByHeader: false,

  // Catch double-renders in dev that would mask state-management bugs.
  reactStrictMode: true,

  typedRoutes: true,

  // Dev-only: the dockerized web container binds 0.0.0.0:3000 but the browser
  // reaches it via localhost / 127.0.0.1 or via the Caddy TLS terminator on
  // raiders.hxxp.io. Next 16 blocks cross-origin requests to dev resources
  // (HMR sockets, RSC payloads) by default — explicitly allow all of these.
  allowedDevOrigins: [
    "localhost",
    "127.0.0.1",
    "0.0.0.0",
    "raiders.hxxp.io",
  ],

  // The nested guild-settings page was folded into the guild detail page.
  // A routing-layer redirect (real 307, no JS needed) keeps old links and
  // bookmarks working without rendering a page first.
  async redirects() {
    return [
      {
        source: "/guild/:guildId/settings",
        destination: "/guild/:guildId",
        permanent: false,
      },
    ];
  },

  // Optional standalone output for slim Docker images. Enable when wiring CI/CD.
  // output: "standalone",
};

export default nextConfig;
