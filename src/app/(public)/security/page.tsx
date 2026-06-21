import type { Metadata } from "next";

import { siteConfig } from "@/lib/site-config";
import {
  ResponsibleDisclosure,
  SecuritySections,
} from "@/components/security-content";

export const metadata: Metadata = {
  title: "Security",
  description: `How ${siteConfig.appName} safeguards data.`,
};

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

      <SecuritySections />

      <ResponsibleDisclosure />
    </article>
  );
}
