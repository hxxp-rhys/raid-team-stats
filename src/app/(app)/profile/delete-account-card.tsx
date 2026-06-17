"use client";

import { useState, type FormEvent } from "react";
import { signOut } from "next-auth/react";

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

const CONFIRM_PHRASE = "DELETE";

export function DeleteAccountCard() {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");

  const del = api.auth.deleteAccount.useMutation({
    onSuccess: async () => {
      await signOut({ callbackUrl: "/", redirect: true });
    },
  });

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    del.mutate({ password });
  };

  const ready = password.length > 0 && confirm === CONFIRM_PHRASE && !del.isPending;

  return (
    <Card className="border-destructive/30">
      <CardHeader>
        <CardTitle className="text-destructive">Delete account</CardTitle>
        <CardDescription>
          Permanently removes your account, characters, snapshots, raid-team
          memberships, and dashboards. Audit-log entries are kept but
          de-identified.
        </CardDescription>
      </CardHeader>
      <form onSubmit={onSubmit} noValidate>
        <CardContent className="space-y-4 pb-6 text-sm">
          <div className="space-y-2">
            <Label htmlFor="delete-password">Password</Label>
            <Input
              id="delete-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="delete-confirm">
              Type {CONFIRM_PHRASE} to confirm
            </Label>
            <Input
              id="delete-confirm"
              type="text"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          {del.error && (
            <p className="text-destructive text-sm" role="alert">
              {del.error.message}
            </p>
          )}
        </CardContent>
        <CardFooter>
          <Button
            type="submit"
            variant="destructive"
            disabled={!ready}
          >
            {del.isPending ? "Deleting…" : "Delete my account"}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}
