"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import type { Route } from "next";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const KNOWN_SAFE_ERRORS = new Set([
  "Too many sign-in attempts. Please wait and try again.",
  "Please verify your email address before signing in.",
  "Authenticator code is incorrect or expired.",
]);

// Map Auth.js OAuth error codes (delivered via `?error=` on the configured
// `pages.error: "/signin"`) to user-facing copy. Anything not listed falls
// back to a generic message so we never expose internal failure details.
const OAUTH_ERROR_MESSAGES: Record<string, string> = {
  AccessDenied: "Sign-in was cancelled.",
  OAuthCallbackError: "Battle.net sign-in failed. Please try again.",
  OAuthSignInError: "Battle.net sign-in failed. Please try again.",
  Configuration: "Sign-in is misconfigured. Please contact an administrator.",
};

// Read `?callbackUrl=` from window.location after hydration. Using
// `useSearchParams()` on a `/signin` page that's served as static HTML
// under Next 16 + cacheComponents leaves the inner Suspense waiting
// forever — there's no per-request server step to unblock it. Reading
// the URL client-side sidesteps the suspension entirely.
export default function SignInPage() {
  const router = useRouter();
  // useState's lazy initializer runs once at mount; on the server it sees
  // no window so falls through to "/profile", on the client it picks up
  // the search param. This avoids both `useSearchParams()` Suspense
  // weirdness on a statically-served route AND the `set-state-in-effect`
  // lint rule.
  const [callbackUrl] = useState<string>(() => {
    if (typeof window === "undefined") return "/profile";
    return (
      new URLSearchParams(window.location.search).get("callbackUrl") ?? "/profile"
    );
  });

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mfaCode, setMfaCode] = useState("");
  const [needsMfa, setNeedsMfa] = useState(false);
  // Seed `error` from `?error=...` so OAuth failures (Auth.js redirects here
  // when `pages.error: "/signin"`) actually surface to the user instead of
  // silently swallowing themselves.
  const [error, setError] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    const code = new URLSearchParams(window.location.search).get("error");
    if (!code) return null;
    return OAUTH_ERROR_MESSAGES[code] ?? "Sign-in failed. Please try again.";
  });
  const [pending, setPending] = useState(false);
  const [bnetPending, setBnetPending] = useState(false);

  const onBattleNetClick = async () => {
    setError(null);
    setBnetPending(true);
    try {
      // Let Auth.js drive the full OAuth redirect. On success we end up at
      // `callbackUrl`; on failure we land back here with `?error=...` which
      // the lazy initializer above turns into a visible message.
      await signIn("battlenet", { callbackUrl });
    } catch {
      setError("Battle.net sign-in failed. Please try again.");
      setBnetPending(false);
    }
  };

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const result = await signIn("credentials", {
        email,
        password,
        mfaCode: needsMfa ? mfaCode.trim() : "",
        redirect: false,
      });
      if (result?.error) {
        const code = result.code ?? "";
        if (code === "mfa_required") {
          setNeedsMfa(true);
          setError(null);
          return;
        }
        setError(
          KNOWN_SAFE_ERRORS.has(code) ? code : "Invalid email or password.",
        );
        return;
      }
      const safe: Route =
        callbackUrl.startsWith("/") && !callbackUrl.startsWith("//")
          ? (callbackUrl as Route)
          : "/profile";
      router.push(safe);
      router.refresh();
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setPending(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sign in</CardTitle>
        <CardDescription>
          {needsMfa
            ? "Enter the 6-digit code from your authenticator (or a recovery code)."
            : "Welcome back."}
        </CardDescription>
      </CardHeader>
      <form onSubmit={onSubmit} noValidate>
        {/* pb-5: CardContent has no vertical padding of its own, so without
            it the password input sits flush against the footer buttons. */}
        <CardContent className="space-y-4 pb-5">
          {!needsMfa ? (
            <>
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="password">Password</Label>
                  <Link
                    href="/reset/request"
                    className="text-muted-foreground text-xs underline-offset-4 hover:underline"
                  >
                    Forgot password?
                  </Link>
                </div>
                <Input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
            </>
          ) : (
            <div className="space-y-2">
              <Label htmlFor="mfa">Authenticator code</Label>
              <Input
                id="mfa"
                type="text"
                inputMode="text"
                autoComplete="one-time-code"
                required
                placeholder="000000"
                value={mfaCode}
                onChange={(e) => setMfaCode(e.target.value)}
              />
            </div>
          )}
          {error && (
            <p className="text-destructive text-sm" role="alert">
              {error}
            </p>
          )}
        </CardContent>
        <CardFooter className="flex flex-col items-stretch gap-3">
          <Button type="submit" disabled={pending || bnetPending}>
            {pending
              ? "Signing in…"
              : needsMfa
                ? "Verify and sign in"
                : "Sign in"}
          </Button>
          {!needsMfa && (
            <>
              <div className="text-muted-foreground flex items-center gap-2 text-xs uppercase tracking-wider">
                <span className="bg-border h-px flex-1" />
                <span>or</span>
                <span className="bg-border h-px flex-1" />
              </div>
              {/* Battle.net sign-in (a primary identity). Signs you in as the
                  linked owner if this Battle.net is already linked; otherwise
                  the signIn callback auto-creates a new (email-less) account
                  and links it. See src/server/auth/index.ts. */}
              <Button
                type="button"
                variant="outline"
                onClick={onBattleNetClick}
                disabled={pending || bnetPending}
              >
                {bnetPending ? "Redirecting…" : "Sign in with Battle.net"}
              </Button>
            </>
          )}
          {needsMfa && (
            <button
              type="button"
              onClick={() => {
                setNeedsMfa(false);
                setMfaCode("");
                setError(null);
              }}
              className="text-muted-foreground text-center text-xs underline-offset-4 hover:underline"
            >
              ← Use a different account
            </button>
          )}
          {!needsMfa && (
            <p className="text-muted-foreground text-center text-sm">
              Don&apos;t have an account?{" "}
              <Link
                href="/signup"
                className="text-primary underline-offset-4 hover:underline"
              >
                Create one
              </Link>
            </p>
          )}
        </CardFooter>
      </form>
    </Card>
  );
}
