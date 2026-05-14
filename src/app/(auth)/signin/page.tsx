"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { signIn } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
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

export default function SignInPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const callbackUrl = searchParams.get("callbackUrl") ?? "/profile";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mfaCode, setMfaCode] = useState("");
  const [needsMfa, setNeedsMfa] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

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
        <CardContent className="space-y-4">
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
          <Button type="submit" disabled={pending}>
            {pending
              ? "Signing in…"
              : needsMfa
                ? "Verify and sign in"
                : "Sign in"}
          </Button>
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
