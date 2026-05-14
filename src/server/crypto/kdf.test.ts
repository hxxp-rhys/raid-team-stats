import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword, needsRehash } from "./kdf";

describe("kdf (Argon2id)", () => {
  it("hashes and verifies a password", async () => {
    const hash = await hashPassword("correct-horse-battery-staple");
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword(hash, "correct-horse-battery-staple")).toBe(true);
  });

  it("rejects a wrong password", async () => {
    const hash = await hashPassword("right");
    expect(await verifyPassword(hash, "wrong")).toBe(false);
  });

  it("refuses to hash an empty password", async () => {
    await expect(hashPassword("")).rejects.toThrow(/empty password/);
  });

  it("rejects an empty password on verify without throwing", async () => {
    const hash = await hashPassword("not-empty");
    expect(await verifyPassword(hash, "")).toBe(false);
  });

  it("returns false rather than throwing on a malformed hash", async () => {
    expect(await verifyPassword("not-a-hash", "anything")).toBe(false);
  });

  it("produces a different hash for the same plaintext each call (random salt)", async () => {
    const a = await hashPassword("repeatable");
    const b = await hashPassword("repeatable");
    expect(a).not.toBe(b);
    // Both must still verify.
    expect(await verifyPassword(a, "repeatable")).toBe(true);
    expect(await verifyPassword(b, "repeatable")).toBe(true);
  });

  it("needsRehash returns false for a freshly hashed value", async () => {
    const hash = await hashPassword("fresh");
    expect(needsRehash(hash)).toBe(false);
  });
});
