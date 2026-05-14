"use client";

import { Suspense, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";

import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
    return (
      <Card>
        <CardHeader>
          <CardTitle>Verification link is missing</CardTitle>
          <CardDescription>
            Open the link from your email exactly as we sent it.
          </CardDescription>
        </CardHeader>
      </Card>
    );
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

export default function VerifyPage() {
  return (
    <Suspense fallback={null}>
      <VerifyInner />
    </Suspense>
  );
}
