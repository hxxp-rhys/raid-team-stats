import type { Metadata } from "next";

import { siteConfig, UPSTREAM } from "@/lib/site-config";

export const metadata: Metadata = {
  title: "Security",
  description: `How ${siteConfig.appName} protects your data.`,
};

const sections: ReadonlyArray<{ title: string; body: string }> = [
  {
    title: "Encryption in transit",
    body: "All traffic is served over HTTPS/TLS. The companion uploader refuses to send your data over an unencrypted connection.",
  },
  {
    title: "Encryption at rest",
    body: "Personal data and third-party access tokens are encrypted in the database with authenticated AES-256-GCM encryption, layered on top of disk-level encryption — so the raw data is unreadable even with direct database access.",
  },
  {
    title: "Passwords & tokens",
    body: "Passwords are never stored directly — they are hashed with the memory-hard Argon2id algorithm. Companion upload tokens are stored only as one-way hashes and rotate automatically on use, so a leaked token stops working after your next sync.",
  },
  {
    title: "Access & sessions",
    body: "Sign-in supports Battle.net OAuth and optional time-based one-time-password (TOTP) two-factor authentication. Read-only share links are cryptographically signed and can be revoked at any time.",
  },
  {
    title: "Hardening",
    body: "The application enforces a strict Content-Security-Policy, rate-limits sensitive endpoints, keeps an audit log of privileged actions, and runs as a non-root, least-privilege container.",
  },
  {
    title: "What we hold — and don't",
    body: "We store the World of Warcraft character, guild, and raid data needed to power your dashboards, plus the email you sign up with. Your data is never sold, rented, or shared with advertisers. It stays private to your guild by default.",
  },
];

export default function SecurityPage() {
  return (
    <article className="space-y-8">
      <header className="space-y-3">
        <h1 className="text-3xl font-bold tracking-tight">Security &amp; your data</h1>
        <p className="text-muted-foreground leading-relaxed">
          {siteConfig.appName} is built to keep your guild&apos;s data private and
          protected. Here, in broad terms, is how it is safeguarded. Because the
          software is self-hosted, each instance is operated independently by
          whoever runs it; this page describes the protections the software
          itself provides.
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
          Found a security issue? Please report it privately via the project&apos;s{" "}
          <a
            href={UPSTREAM.repoUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-foreground underline underline-offset-4 hover:no-underline"
          >
            GitHub repository
          </a>{" "}
          rather than opening a public issue, so it can be fixed before it is
          widely known.
        </p>
      </section>
    </article>
  );
}
