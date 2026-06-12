"use client";

import {
  useEffect,
  useId,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type DangerZoneModalProps = {
  open: boolean;
  /** Backdrop click / Escape / Cancel. Ignored while the mutation runs. */
  onClose: () => void;
  /** e.g. `Delete "Eclipse"` — rendered under the Danger Zone heading. */
  title: string;
  description: ReactNode;
  /** The exact string the user must type to enable the confirm button. */
  expectedConfirm: string;
  onConfirm: () => void;
  isPending: boolean;
  errorMessage?: string | null;
  confirmLabel: string;
  submittingLabel: string;
  helper?: ReactNode;
};

/**
 * "Danger Zone" lightbox for destructive actions. Same AWS-style semantics
 * as DestructiveConfirmCard (type the exact resource name to arm the
 * button) but as a modal pop-up: backdrop + Escape close and focus on the
 * confirm input. The inner dialog only MOUNTS while open, so the typed
 * value is naturally fresh every time it opens — a re-opened dialog is
 * never pre-armed (and no set-state-in-effect reset is needed).
 */
export function DangerZoneModal(props: DangerZoneModalProps) {
  if (!props.open) return null;
  return <DangerZoneDialog {...props} />;
}

function DangerZoneDialog({
  onClose,
  title,
  description,
  expectedConfirm,
  onConfirm,
  isPending,
  errorMessage,
  confirmLabel,
  submittingLabel,
  helper,
}: DangerZoneModalProps) {
  const [confirm, setConfirm] = useState("");
  const titleId = useId();
  const inputId = useId();

  useEffect(() => {
    // Escape honors the same isPending guard as backdrop/Cancel — closing
    // mid-mutation would unmount the dialog and swallow a failure message
    // on a destructive action. Body scroll locks while open (parity with
    // the shared Modal component).
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !isPending) onClose();
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose, isPending]);

  const ready = confirm.trim() === expectedConfirm && !isPending;
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!ready) return;
    onConfirm();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
    >
      <button
        type="button"
        aria-label="Close"
        className="absolute inset-0 cursor-default bg-black/60"
        onClick={() => {
          if (!isPending) onClose();
        }}
      />
      <div className="border-destructive/40 bg-card relative w-full max-w-md rounded-lg border p-5 shadow-lg">
        <p className="text-destructive text-xs font-semibold uppercase tracking-wide">
          Danger zone
        </p>
        <h2 id={titleId} className="mt-1 text-lg font-semibold">
          {title}
        </h2>
        <div className="text-muted-foreground mt-2 text-sm">{description}</div>

        <form onSubmit={onSubmit} noValidate className="mt-4 space-y-3">
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
          <div className="flex gap-2">
            <Button type="submit" variant="destructive" disabled={!ready}>
              {isPending ? submittingLabel : confirmLabel}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={isPending}
            >
              Cancel
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
