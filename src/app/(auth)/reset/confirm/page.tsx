"use client";

import { Suspense, useState, type FormEvent } from "react";
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
import { passwordSchema } from "@/server/auth/schemas";

function ResetConfirmInner() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token") ?? "";

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const reset = api.auth.confirmPasswordReset.useMutation();

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setFieldError(null);
    if (password !== confirm) {
      setFieldError("Passwords do not match.");
      return;
    }
    const parsed = passwordSchema.safeParse(password);
    if (!parsed.success) {
      setFieldError(parsed.error.issues[0]?.message ?? "Invalid password.");
      return;
    }
    reset.mutate({ token, password });
  };

  if (!token) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Reset link is missing</CardTitle>
          <CardDescription>
            Open the link from your email exactly as we sent it.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (reset.data?.ok) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Password updated</CardTitle>
          <CardDescription>Sign in with your new password.</CardDescription>
        </CardHeader>
        <CardFooter>
          <Link
            href="/signin"
            className="text-primary text-sm underline-offset-4 hover:underline"
          >
            Continue to sign in →
          </Link>
        </CardFooter>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Set a new password</CardTitle>
        <CardDescription>At least 12 characters.</CardDescription>
      </CardHeader>
      <form onSubmit={onSubmit} noValidate>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="password">New password</Label>
            <Input
              id="password"
              type="password"
              autoComplete="new-password"
              minLength={12}
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="confirm">Confirm</Label>
            <Input
              id="confirm"
              type="password"
              autoComplete="new-password"
              required
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </div>
          {(fieldError || reset.error) && (
            <p className="text-destructive text-sm" role="alert">
              {fieldError ?? reset.error?.message}
            </p>
          )}
        </CardContent>
        <CardFooter>
          <Button type="submit" disabled={reset.isPending} className="w-full">
            {reset.isPending ? "Saving…" : "Save new password"}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}

export default function ResetConfirmPage() {
  return (
    <Suspense fallback={null}>
      <ResetConfirmInner />
    </Suspense>
  );
}
