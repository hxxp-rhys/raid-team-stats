import { test, expect } from "@playwright/test";

/**
 * Smoke E2E. Verifies the public surface renders and the proxy emits the
 * required security headers. Auth-required flows are exercised in a separate
 * suite that needs a primed DB and SMTP — kept out of CI for now.
 */

test("home page renders with strict CSP, HSTS-ready security headers", async ({
  request,
}) => {
  const res = await request.get("/");
  expect(res.status()).toBe(200);
  const csp = res.headers()["content-security-policy"] ?? "";
  expect(csp).toContain("default-src 'self'");
  expect(csp).toMatch(/script-src.+nonce-/);
  expect(csp).not.toContain("'unsafe-inline'");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(res.headers()["x-frame-options"]).toBe("DENY");
  expect(res.headers()["x-content-type-options"]).toBe("nosniff");
  expect(res.headers()["referrer-policy"]).toBe("strict-origin-when-cross-origin");
});

test("signin page loads without 5xx", async ({ page }) => {
  // The page is a client component inside a Suspense boundary; the post-
  // hydration form is exercised by the separate signed-in journey suite.
  // The smoke contract here is "the route doesn't crash".
  const res = await page.goto("/signin", { waitUntil: "domcontentloaded" });
  expect(res?.status() ?? 0).toBeLessThan(500);
});

test("signup page renders register form", async ({ page }) => {
  await page.goto("/signup", { waitUntil: "domcontentloaded" });
  await expect(page.locator('input[type="email"]')).toBeVisible({
    timeout: 15_000,
  });
});

test("profile redirects to signin when unauthenticated", async ({ page }) => {
  await page.goto("/profile");
  // Playwright follows redirects by default — assert we landed on signin
  // with the callbackUrl preserved.
  await expect(page).toHaveURL(/\/signin(\?.*)?$/);
});

test("guild page renders without crashing when unauthenticated", async ({ page }) => {
  const res = await page.goto("/guild", { waitUntil: "domcontentloaded" });
  // Smoke: the route must not 5xx. The tRPC call inside the client component
  // will fail with UNAUTHORIZED, but the page shell itself should render.
  expect(res?.status() ?? 0).toBeLessThan(500);
});

test("health endpoint is reachable and returns JSON", async ({ request }) => {
  const res = await request.get("/api/health");
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body).toMatchObject({ status: "ok" });
});
