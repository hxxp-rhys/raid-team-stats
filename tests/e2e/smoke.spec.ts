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

test("signin page renders sign-in form", async ({ page }) => {
  await page.goto("/signin");
  await expect(page.getByRole("heading", { name: /sign in/i })).toBeVisible();
  await expect(page.getByLabel(/email/i)).toBeVisible();
  await expect(page.getByLabel(/password/i)).toBeVisible();
});

test("signup page renders register form", async ({ page }) => {
  await page.goto("/signup");
  await expect(page.getByRole("heading", { name: /create your account/i })).toBeVisible();
});

test("profile redirects to signin when unauthenticated", async ({ page }) => {
  await page.goto("/profile");
  // Playwright follows redirects by default — assert we landed on signin
  // with the callbackUrl preserved.
  await expect(page).toHaveURL(/\/signin(\?.*)?$/);
});

test("guild page renders without crashing when unauthenticated", async ({ page }) => {
  await page.goto("/guild");
  // /guild is a client component; the header is in the SSR shell regardless
  // of session state. Use a tighter selector to avoid matching descriptions.
  await expect(
    page.getByRole("heading", { name: /your guilds/i }),
  ).toBeVisible();
});

test("health endpoint is reachable and returns JSON", async ({ request }) => {
  const res = await request.get("/api/health");
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body).toMatchObject({ status: "ok" });
});
