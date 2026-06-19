"use client";

import { useId, useState, type FormEvent, type ReactNode } from "react";

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

/**
 * Reusable destructive-confirm card. Two-stage UX:
 *   1) Compact "Delete <thing>" button.
 *   2) On click, expands inline to a Name-confirm form. User must type the
 *      exact `expectedConfirm` string before the submit button enables. A
 *      Cancel collapses back to stage 1.
 *
 * Why this shape: matches AWS-style high-stakes deletions (type the
 * resource name, not a generic word like DELETE), so an admin holding
 * two tabs open can't accidentally delete the wrong entity. Reused by
 * raid-team delete and guild delete in the guild settings page.
 */
export function DestructiveConfirmCard({
  title,
  description,
  expectedConfirm,
  onConfirm,
  isPending,
  errorMessage,
  buttonLabel,
  submittingLabel,
  helper,
}: {
  /** Card header — e.g. "Delete Eclipse Midnight" or "Delete this guild". */
  title: string;
  /** Short paragraph describing what gets removed (cascade summary). */
  description: ReactNode;
  /** The exact string the user must type to enable the submit button. */
  expectedConfirm: string;
  /** Fires when the user confirms. Should call the mutation. */
  onConfirm: () => void;
  /** Mutation pending flag — disables the submit button + shows progress. */
  isPending: boolean;
  /** Server-side or validation error message; rendered in role=alert. */
  errorMessage?: string | null;
  /** Label on the compact "Delete X" button (stage 1). */
  buttonLabel: string;
  /** Label on the submit button while the mutation is pending. */
  submittingLabel: string;
  /** Optional small helper text under the type-name input. */
  helper?: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const [confirm, setConfirm] = useState("");
  const inputId = useId();

  const ready = confirm.trim() === expectedConfirm && !isPending;

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!ready) return;
    onConfirm();
  };

  const onCancel = () => {
    setExpanded(false);
    setConfirm("");
  };

  return (
    <Card className="border-destructive/30">
      <CardHeader>
        <CardTitle className="text-destructive">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      {!expanded ? (
        <CardFooter>
          <Button
            type="button"
            variant="destructive"
            onClick={() => setExpanded(true)}
          >
            {buttonLabel}
          </Button>
        </CardFooter>
      ) : (
        <form onSubmit={onSubmit} noValidate>
          <CardContent className="space-y-3 pb-5 text-sm">
            <div className="space-y-2">
              <Label htmlFor={inputId}>
                Type <span className="font-semibold">{expectedConfirm}</span> to
                confirm
              </Label>
              <Input
                id={inputId}
                type="text"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                aria-describedby={helper ? `${inputId}-helper` : undefined}
                autoFocus
              />
              {helper && (
                <p
                  id={`${inputId}-helper`}
                  className="text-muted-foreground text-xs"
                >
                  {helper}
                </p>
              )}
            </div>
            {errorMessage && (
              <p className="text-destructive text-sm" role="alert">
                {errorMessage}
              </p>
            )}
          </CardContent>
          <CardFooter className="flex gap-2">
            <Button
              type="submit"
              variant="destructive"
              disabled={!ready}
            >
              {isPending ? submittingLabel : buttonLabel}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={onCancel}
              disabled={isPending}
            >
              Cancel
            </Button>
          </CardFooter>
        </form>
      )}
    </Card>
  );
}
