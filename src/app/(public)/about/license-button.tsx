"use client";

import { useState } from "react";

import { Modal } from "@/components/ui/modal";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * "View license" button that opens a lightbox showing the project's license:
 * a short plain-language summary up top, then the full license text in a
 * scrollable pane. The full text is passed in from the server page (read from
 * LICENSE.md at build time) so the client never needs filesystem access; if it
 * couldn't be read, the summary + authoritative links still stand on their own.
 */
export function LicenseButton({
  licenseName,
  licenseText,
  repoUrl,
  fullTextUrl,
}: {
  licenseName: string;
  licenseText: string;
  repoUrl: string;
  fullTextUrl: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
      >
        View license
      </button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="License"
        description={licenseName}
        showCloseIcon
        hideDefaultFooter
        className="max-w-3xl"
      >
        <div className="space-y-4 text-sm">
          <p className="text-muted-foreground leading-relaxed">
            This software is{" "}
            <span className="text-foreground font-medium">free and open source</span>{" "}
            under the {licenseName}. You are free to use, study, share, and
            modify it. If you run a modified version as a network service, the
            license requires you to offer your users the corresponding source.
          </p>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
            <a
              href={fullTextUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-foreground underline underline-offset-4 hover:no-underline"
            >
              Full license on gnu.org ↗
            </a>
            <a
              href={repoUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-foreground underline underline-offset-4 hover:no-underline"
            >
              Source repository ↗
            </a>
          </div>

          {licenseText ? (
            <div className="space-y-1">
              <p className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
                Full text
              </p>
              <pre className="border-border bg-muted/30 max-h-[45vh] overflow-auto whitespace-pre-wrap rounded-md border p-3 font-mono text-[11px] leading-relaxed">
                {licenseText}
              </pre>
            </div>
          ) : (
            <p className="text-muted-foreground text-xs">
              The full license text is included with the source (LICENSE.md) and
              available at the links above.
            </p>
          )}
        </div>
      </Modal>
    </>
  );
}
