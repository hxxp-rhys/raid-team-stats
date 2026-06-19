"use client";

import { Suspense, useEffect, useState, type FormEvent } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";

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
import { api } from "@/lib/trpc-client";

function VerifyInner() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token") ?? "";

  const verify = api.auth.verifyEmail.useMutation();

  // useRef to ensure we only fire once per token (StrictMode double-invoke
  // protection in dev).
  useEffect(() => {
    if (!token) return;
    if (verify.isIdle) verify.mutate({ token });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  if (!token) {
    return <ResendForm />;
  }

  if (verify.isPending || verify.isIdle) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Verifying your email…</CardTitle>
          <CardDescription>One moment.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (verify.error) {
    return (
      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>Verification failed</CardTitle>
            <CardDescription>{verify.error.message}</CardDescription>
          </CardHeader>
          <CardFooter>
            <Link
              href="/signin"
              className="text-primary text-sm underline-offset-4 hover:underline"
            >
              Back to sign in
            </Link>
          </CardFooter>
        </Card>
        <ResendForm />
      </div>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Email verified</CardTitle>
        <CardDescription>You can now sign in.</CardDescription>
      </CardHeader>
      <CardContent>
        <Link
          href="/signin"
          className="text-primary text-sm underline-offset-4 hover:underline"
        >
          Continue to sign in →
        </Link>
      </CardContent>
    </Card>
  );
}

function ResendForm() {
  const [email, setEmail] = useState("");
  const resend = api.auth.resendVerification.useMutation();
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    resend.mutate({ email: email.trim().toLowerCase() });
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>Didn&apos;t get the email?</CardTitle>
        <CardDescription>
          Enter the address you registered with and we&apos;ll send a fresh
          verification link. Check your spam folder first — verification
          messages from new domains sometimes land there.
        </CardDescription>
      </CardHeader>
      <form onSubmit={onSubmit}>
        <CardContent className="space-y-3 pb-5">
          <div className="space-y-1.5">
            <Label htmlFor="resend-email">Email</Label>
            <Input
              id="resend-email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          {resend.data?.ok && (
            <p className="text-muted-foreground text-sm">
              If that address has an unverified account, a new verification
              link is on the way.
            </p>
          )}
          {resend.error && (
            <p className="text-destructive text-sm" role="alert">
              {resend.error.message}
            </p>
          )}
        </CardContent>
        <CardFooter>
          <Button
            type="submit"
            size="sm"
            disabled={resend.isPending || email.length === 0}
          >
            {resend.isPending ? "Sending…" : "Resend verification email"}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}

export default function VerifyPage() {
  return (
    <Suspense fallback={null}>
      <VerifyInner />
    </Suspense>
  );
}
