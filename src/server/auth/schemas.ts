import { z } from "zod";

/**
 * Shared shape for credential inputs. Validation rules are intentionally
 * server-side only — the UI may relax some constraints for typeability, but
 * the server is the source of truth.
 */

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, "Email is required")
  .max(254, "Email is too long")
  .email("Enter a valid email address");

// NIST SP 800-63B-aligned password policy: length-based, no composition rules.
// 12 chars min, 128 max. We deliberately do not require special characters
// (causes weaker, more predictable passwords) or block-list common ones here
// (would need haveibeenpwned integration — Phase 2.x).
export const passwordSchema = z
  .string()
  .min(12, "Password must be at least 12 characters")
  .max(128, "Password is too long");

export const credentialsSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
});

export const registerSchema = credentialsSchema.extend({
  displayName: z
    .string()
    .trim()
    .min(1, "Display name is required")
    .max(50, "Display name is too long"),
});

export type CredentialsInput = z.infer<typeof credentialsSchema>;
export type RegisterInput = z.infer<typeof registerSchema>;
