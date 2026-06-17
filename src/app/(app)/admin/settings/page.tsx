"use client";

import { useState } from "react";

import { api, type RouterOutputs } from "@/lib/trpc-client";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

type Settings = RouterOutputs["settings"]["get"];

export default function AdminSettingsPage() {
  const q = api.settings.get.useQuery();
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Settings</h2>
        <p className="text-muted-foreground text-sm">
          Platform customization + policy. Changes are recorded in the audit log.
        </p>
      </div>
      {q.isPending ? (
        <p className="text-muted-foreground text-sm">Loading…</p>
      ) : q.error ? (
        <p className="text-destructive text-sm">{q.error.message}</p>
      ) : (
        // Key by the loaded value so the form re-seeds its lazy state if the
        // settings change underneath it.
        <SettingsForm key={JSON.stringify(q.data)} initial={q.data} />
      )}
    </div>
  );
}

function RetentionInput({
  label,
  value,
  onChange,
  enforcement,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  enforcement: string;
}) {
  return (
    <div className="border-border flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        <div className="text-muted-foreground text-[11px]">{enforcement}</div>
      </div>
      <div className="flex items-center gap-2">
        <input
          type="number"
          min={1}
          max={3650}
          value={value}
          placeholder="∞"
          onChange={(e) => onChange(e.target.value)}
          className="border-border bg-background h-9 w-24 rounded-md border px-2 text-right text-sm tabular-nums"
          aria-label={`${label} retention in days`}
        />
        <span className="text-muted-foreground text-xs">days</span>
      </div>
    </div>
  );
}

function SettingsForm({ initial }: { initial: Settings }) {
  const utils = api.useUtils();
  const save = api.settings.update.useMutation({
    onSuccess: () => utils.settings.get.invalidate(),
  });

  const [audit, setAudit] = useState(
    initial.auditLogRetentionDays?.toString() ?? "",
  );
  const [sync, setSync] = useState(
    initial.syncRunRetentionDays?.toString() ?? "",
  );
  const [access, setAccess] = useState(
    initial.accessLogRetentionDays?.toString() ?? "",
  );
  const [metrics, setMetrics] = useState(
    initial.metricsRetentionDays?.toString() ?? "",
  );
  const [loginThresh, setLoginThresh] = useState(
    initial.loginFailureAlertThreshold.toString(),
  );
  const [loginWin, setLoginWin] = useState(
    initial.loginFailureWindowMinutes.toString(),
  );

  // "" → null (keep forever); else a clamped positive integer.
  const parseRet = (s: string): number | null => {
    const t = s.trim();
    if (t === "") return null;
    const n = Math.floor(Number(t));
    return Number.isFinite(n) && n >= 1 ? Math.min(n, 3650) : null;
  };

  const onSave = () =>
    save.mutate({
      auditLogRetentionDays: parseRet(audit),
      syncRunRetentionDays: parseRet(sync),
      accessLogRetentionDays: parseRet(access),
      metricsRetentionDays: parseRet(metrics),
      loginFailureAlertThreshold: Math.max(
        1,
        Math.min(100000, Math.floor(Number(loginThresh)) || 20),
      ),
      loginFailureWindowMinutes: Math.max(
        1,
        Math.min(1440, Math.floor(Number(loginWin)) || 5),
      ),
    });

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Data retention</CardTitle>
          <CardDescription>
            How long each log type is kept. Leave blank (∞) to keep forever.
            DB logs are pruned by a daily worker job; access/traffic logs are
            enforced in Loki.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <RetentionInput
            label="Audit log"
            value={audit}
            onChange={setAudit}
            enforcement="Security/audit trail (DB) — pruned by the retention job."
          />
          <RetentionInput
            label="Sync runs"
            value={sync}
            onChange={setSync}
            enforcement="Ingestion job history (DB) — pruned by the retention job."
          />
          <RetentionInput
            label="Access / traffic logs"
            value={access}
            onChange={setAccess}
            enforcement="Caddy HTTP logs (Loki) — enforced immediately via Loki's delete API, then natively by Loki's compactor after its next restart."
          />
          <RetentionInput
            label="Metrics"
            value={metrics}
            onChange={setMetrics}
            enforcement="Prometheus — written to config; applied on the next Prometheus restart (startup flag)."
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Security alerts</CardTitle>
          <CardDescription>
            Thresholds the Security tab uses to flag concerning activity.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="border-border flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
            <div className="text-sm font-medium">Login-failure spike</div>
            <div className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">flag at</span>
              <input
                type="number"
                min={1}
                value={loginThresh}
                onChange={(e) => setLoginThresh(e.target.value)}
                className="border-border bg-background h-9 w-20 rounded-md border px-2 text-right tabular-nums"
                aria-label="Login-failure alert threshold"
              />
              <span className="text-muted-foreground">failures within</span>
              <input
                type="number"
                min={1}
                value={loginWin}
                onChange={(e) => setLoginWin(e.target.value)}
                className="border-border bg-background h-9 w-20 rounded-md border px-2 text-right tabular-nums"
                aria-label="Login-failure window in minutes"
              />
              <span className="text-muted-foreground">min</span>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="flex items-center gap-3">
        <Button onClick={onSave} disabled={save.isPending}>
          {save.isPending ? "Saving…" : "Save settings"}
        </Button>
        {save.isSuccess && (
          <span className="text-xs text-emerald-500">Saved ✓</span>
        )}
        {save.error && (
          <span className="text-destructive text-xs" role="alert">
            {save.error.message}
          </span>
        )}
      </div>
    </>
  );
}
