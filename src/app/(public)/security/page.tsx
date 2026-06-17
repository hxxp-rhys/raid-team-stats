import type { Metadata } from "next";

import { siteConfig, UPSTREAM } from "@/lib/site-config";

export const metadata: Metadata = {
  title: "Security",
  description: `How ${siteConfig.appName} safeguards data.`,
};

const sections: ReadonlyArray<{ title: string; body: string }> = [
  {
    title: "Encryption in transit",
    body: "The companion uploader refuses to send data over anything but an encrypted (HTTPS) connection, and the included production configuration serves the site over HTTPS/TLS with HSTS.",
  },
  {
    title: "Encryption at rest",
    body: "Sensitive fields are encrypted in the database by the application itself using authenticated AES-256-GCM: account email addresses, third-party (OAuth) access tokens, two-factor-authentication secrets, display names and avatars, and recruitment-form answers. Each value gets a fresh random IV and an authentication tag, so it cannot be read or altered without the key. (Email uses a separate keyed blind index so you can still sign in without the address ever being stored in the clear.)",
  },
  {
    title: "Passwords & tokens",
    body: "Account passwords are never stored — only a one-way Argon2id hash (a slow, memory-hard algorithm) is kept, so the original cannot be recovered. Companion upload tokens are stored only as SHA-256 hashes and rotate automatically on each sync, so a leaked token stops working after the next upload.",
  },
  {
    title: "Access & sessions",
    body: "Sign-in supports Battle.net (OAuth) and email + password, with optional time-based one-time-password (TOTP) two-factor authentication. Read-only share links are signed with HMAC-SHA256 and can be switched off at any time, which immediately re-locks every outstanding link. Guild and team data is private by default and checked against your role on every request.",
  },
  {
    title: "Hardening & logging",
    body: "The app enforces a strict, nonce-based Content-Security-Policy, rate-limits sign-in and other sensitive endpoints, and records an append-only audit log of privileged actions. In the shipped setup it runs as a non-root container with Linux capabilities dropped and privilege-escalation disabled. Personal data and secrets — including email addresses and tokens — are stripped from the application's logs.",
  },
  {
    title: "What's collected — and what isn't",
    body: "To power your dashboards the app stores World of Warcraft character, guild, and raid data, plus the email address used to sign in — all on the infrastructure of whoever operates this instance, not the project's. Your email is used only as your login identifier and for any notifications you turn on; it is encrypted at rest, sent over encrypted connections, kept out of the application's logs, and access-controlled. The software ships with no advertising, third-party analytics, or data-broker integrations, and so has no means to sell, rent, or share your data.",
  },
];

export default function SecurityPage() {
  return (
    <article className="space-y-8">
      <header className="space-y-3">
        <h1 className="text-3xl font-bold tracking-tight">Security &amp; your data</h1>
        <p className="text-muted-foreground leading-relaxed">
          {siteConfig.appName}{" "}
          is built to keep a guild&apos;s data private and protected. Below, in
          broad terms, are the safeguards the software provides. It is
          self-hosted: each instance is set up and run independently by whoever
          operates it, on infrastructure they control — so this page describes
          what the software itself does, not any particular operator&apos;s
          systems.
        </p>
      </header>

      <dl className="space-y-5">
        {sections.map((s) => (
          <div
            key={s.title}
            className="border-border/60 border-l-2 pl-4"
          >
            <dt className="font-semibold tracking-tight">{s.title}</dt>
            <dd className="text-muted-foreground mt-1 text-sm leading-relaxed">
              {s.body}
            </dd>
          </div>
        ))}
      </dl>

      <section className="border-border bg-muted/30 space-y-2 rounded-lg border p-5">
        <h2 className="text-sm font-semibold tracking-tight">
          Responsible disclosure
        </h2>
        <p className="text-muted-foreground text-sm leading-relaxed">
          Found a security vulnerability? Please report it privately through the
          project&apos;s{" "}
          <a
            href={UPSTREAM.repoUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-foreground underline underline-offset-4 hover:no-underline"
          >
            GitHub repository
          </a>{" "}
          (a private security advisory) rather than opening a public issue, so it
          can be fixed before it is widely known. Other bugs are welcome as a
          regular GitHub issue.
        </p>
      </section>
    </article>
  );
}
