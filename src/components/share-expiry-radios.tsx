"use client";

import { useId } from "react";

import { SHARE_EXPIRY_OPTIONS } from "@/lib/share-expiry";

/**
 * Radio group for choosing a share link's expiry. `value` is the selected
 * ttlDays (null = never). Used by every "create share link" surface so the
 * options + default stay consistent — see @/lib/share-expiry.
 */
export function ShareExpiryRadios({
  value,
  onChange,
  disabled,
}: {
  value: number | null;
  onChange: (days: number | null) => void;
  disabled?: boolean;
}) {
  // Unique group name + ids so two instances on one page never cross-link.
  const uid = useId();
  return (
    <fieldset className="space-y-1.5" disabled={disabled}>
      <legend className="text-xs font-medium">Link expires</legend>
      <div className="flex flex-wrap gap-x-4 gap-y-1.5">
        {SHARE_EXPIRY_OPTIONS.map((opt) => {
          const id = `${uid}-${opt.days ?? "never"}`;
          return (
            <label
              key={id}
              htmlFor={id}
              className="flex cursor-pointer items-center gap-1.5 text-sm"
            >
              <input
                id={id}
                type="radio"
                name={uid}
                className="accent-primary"
                checked={value === opt.days}
                onChange={() => onChange(opt.days)}
                disabled={disabled}
              />
              {opt.label}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
