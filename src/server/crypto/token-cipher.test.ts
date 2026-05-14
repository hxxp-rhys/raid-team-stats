import { describe, expect, it } from "vitest";
import { encryptToken, decryptToken, isEncrypted } from "./token-cipher";

describe("token-cipher", () => {
  it("round-trips a typical OAuth token", () => {
    const plaintext = "ya29.a0AfH6SMBxyz_abc-123.4567.890_def";
    const encrypted = encryptToken(plaintext);
    expect(encrypted).not.toBeNull();
    expect(encrypted).not.toBe(plaintext);
    expect(decryptToken(encrypted)).toBe(plaintext);
  });

  it("passes null and undefined through unchanged", () => {
    expect(encryptToken(null)).toBeNull();
    expect(encryptToken(undefined)).toBeNull();
    expect(decryptToken(null)).toBeNull();
    expect(decryptToken(undefined)).toBeNull();
  });

  it("round-trips an empty string", () => {
    expect(decryptToken(encryptToken(""))).toBe("");
  });

  it("round-trips a long token", () => {
    const long = "x".repeat(8192);
    expect(decryptToken(encryptToken(long))).toBe(long);
  });

  it("produces a different ciphertext on every call (random IV)", () => {
    const plaintext = "the same input";
    const a = encryptToken(plaintext);
    const b = encryptToken(plaintext);
    expect(a).not.toBe(b);
    expect(decryptToken(a)).toBe(plaintext);
    expect(decryptToken(b)).toBe(plaintext);
  });

  it("rejects tampered ciphertext", () => {
    const encrypted = encryptToken("legitimate")!;
    const buf = Buffer.from(encrypted, "base64");
    // Flip a bit deep in the ciphertext region (past version + IV + tag).
    buf[buf.length - 1] = buf[buf.length - 1]! ^ 0x01;
    const tampered = buf.toString("base64");
    expect(() => decryptToken(tampered)).toThrow();
  });

  it("rejects an envelope shorter than the header", () => {
    expect(() => decryptToken("AAAA")).toThrow(/too short/);
  });

  it("rejects an unknown version byte", () => {
    const encrypted = encryptToken("payload")!;
    const buf = Buffer.from(encrypted, "base64");
    buf[0] = 0xff;
    expect(() => decryptToken(buf.toString("base64"))).toThrow(/unsupported cipher version/);
  });

  it("isEncrypted recognises a valid envelope", () => {
    expect(isEncrypted(encryptToken("hi"))).toBe(true);
  });

  it("isEncrypted rejects plain strings, garbage, and null", () => {
    expect(isEncrypted("plain text")).toBe(false);
    expect(isEncrypted("not-base64!!!")).toBe(false);
    expect(isEncrypted(null)).toBe(false);
    expect(isEncrypted(undefined)).toBe(false);
  });
});
