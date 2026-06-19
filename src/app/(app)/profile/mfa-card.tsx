"use client";

import { useState, type FormEvent } from "react";
import QRCode from "qrcode";

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

export function MfaCard() {
  const status = api.mfa.status.useQuery();
  const utils = api.useUtils();

  // Enrollment state machine: idle → started (QR + secret) → confirmed
  // (recovery codes once) → done (status refetched).
  const [stage, setStage] = useState<"idle" | "started" | "saved">("idle");
  const [secret, setSecret] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);

  // Disable state
  const [disablePassword, setDisablePassword] = useState("");
  const [disableCode, setDisableCode] = useState("");

  const start = api.mfa.startEnrollment.useMutation({
    onSuccess: async (data) => {
      setSecret(data.secretBase32);
      setStage("started");
      try {
        const dataUrl = await QRCode.toDataURL(data.otpauthUrl, { margin: 1 });
        setQrDataUrl(dataUrl);
      } catch {
        setQrDataUrl(null);
      }
    },
  });
  const confirm = api.mfa.confirmEnrollment.useMutation({
    onSuccess: async (data) => {
      setRecoveryCodes(data.recoveryCodes);
      setStage("saved");
      setCode("");
      await utils.mfa.status.invalidate();
    },
  });
  const disable = api.mfa.disable.useMutation({
    onSuccess: async () => {
      setDisablePassword("");
      setDisableCode("");
      await utils.mfa.status.invalidate();
    },
  });

  const onStart = () => start.mutate();
  const onConfirm = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    confirm.mutate({ code: code.trim() });
  };
  const onDisable = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    disable.mutate({
      password: disablePassword,
      codeOrRecovery: disableCode.trim(),
    });
  };

  return (
    <Card id="mfa">
      <CardHeader>
        <CardTitle>Two-factor authentication</CardTitle>
        <CardDescription>
          Time-based one-time passwords (RFC 6238). Works with 1Password,
          Authy, Bitwarden, Google Authenticator, and any other TOTP app.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 pb-5 text-sm">
        {status.isPending ? (
          <p className="text-muted-foreground">Loading…</p>
        ) : status.data?.enabled ? (
          <>
            <p>
              Status: <span className="text-green-500">Enabled</span>
            </p>
            <form onSubmit={onDisable} className="space-y-3">
              <p className="text-muted-foreground text-xs">
                To disable, confirm with your current password AND a fresh
                authenticator code or recovery code.
              </p>
              <div className="space-y-2">
                <Label htmlFor="disable-password">Password</Label>
                <Input
                  id="disable-password"
                  type="password"
                  autoComplete="current-password"
                  value={disablePassword}
                  onChange={(e) => setDisablePassword(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="disable-code">
                  Authenticator code (or recovery code)
                </Label>
                <Input
                  id="disable-code"
                  type="text"
                  inputMode="text"
                  autoComplete="one-time-code"
                  value={disableCode}
                  onChange={(e) => setDisableCode(e.target.value)}
                  required
                />
              </div>
              {disable.error && (
                <p className="text-destructive text-sm" role="alert">
                  {disable.error.message}
                </p>
              )}
              <Button
                type="submit"
                variant="destructive"
                size="sm"
                disabled={
                  disable.isPending ||
                  !disablePassword ||
                  !disableCode.trim()
                }
              >
                {disable.isPending ? "Disabling…" : "Disable 2FA"}
              </Button>
            </form>
          </>
        ) : stage === "idle" ? (
          <>
            <p className="text-muted-foreground">Not enabled.</p>
            <Button onClick={onStart} disabled={start.isPending} size="sm">
              {start.isPending ? "Starting…" : "Enable 2FA"}
            </Button>
            {start.error && (
              <p className="text-destructive text-sm" role="alert">
                {start.error.message}
              </p>
            )}
          </>
        ) : stage === "started" ? (
          <>
            <p>1. Scan this QR with your authenticator app.</p>
            {qrDataUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={qrDataUrl}
                alt="MFA QR code"
                width={180}
                height={180}
                className="bg-background rounded-md p-1"
              />
            ) : (
              <p className="text-muted-foreground text-xs">
                QR generation failed; enter the secret manually below.
              </p>
            )}
            <p className="text-muted-foreground text-xs">
              Or enter this secret manually:
            </p>
            <code className="bg-muted/40 block break-all rounded px-2 py-1 text-xs">
              {secret}
            </code>
            <form onSubmit={onConfirm} className="space-y-3">
              <p>2. Enter the 6-digit code your app shows.</p>
              <Input
                type="text"
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength={6}
                placeholder="000000"
                autoComplete="one-time-code"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                required
              />
              {confirm.error && (
                <p className="text-destructive text-sm" role="alert">
                  {confirm.error.message}
                </p>
              )}
              <Button
                type="submit"
                size="sm"
                disabled={confirm.isPending || code.length !== 6}
              >
                {confirm.isPending ? "Confirming…" : "Confirm"}
              </Button>
            </form>
          </>
        ) : (
          // saved: show recovery codes once
          <>
            <p className="text-green-500">2FA is enabled. ✓</p>
            <p className="font-medium">Save these recovery codes now.</p>
            <p className="text-muted-foreground text-xs">
              Each is single-use and only shown once. Keep them somewhere safe
              (a password manager is ideal). They&apos;ll let you disable 2FA
              if you lose your authenticator.
            </p>
            <ul className="bg-muted/30 grid grid-cols-2 gap-2 rounded-md p-3 font-mono text-xs">
              {recoveryCodes?.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setRecoveryCodes(null);
                setStage("idle");
              }}
            >
              I&apos;ve saved them
            </Button>
          </>
        )}
      </CardContent>
      <CardFooter className="text-muted-foreground text-xs">
        Recovery codes are hashed at rest with Argon2id; the TOTP secret is
        AES-256-GCM encrypted.
      </CardFooter>
    </Card>
  );
}
