import { describe, expect, it } from "vitest";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";

import { verifyInteractionSignature } from "./verify";

/** Generate an Ed25519 keypair and return the raw public key as hex. */
function makeKeys() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return { publicKeyHex: raw.toString("hex"), privateKey };
}

function signed(privateKey: ReturnType<typeof makeKeys>["privateKey"], timestamp: string, body: string) {
  return cryptoSign(null, Buffer.from(timestamp + body, "utf8"), privateKey).toString("hex");
}

describe("verifyInteractionSignature", () => {
  it("accepts a correctly signed request", () => {
    const { publicKeyHex, privateKey } = makeKeys();
    const ts = "1700000000";
    const body = '{"type":1}';
    const sig = signed(privateKey, ts, body);
    expect(verifyInteractionSignature(body, sig, ts, publicKeyHex)).toBe(true);
  });

  it("rejects a tampered body", () => {
    const { publicKeyHex, privateKey } = makeKeys();
    const ts = "1700000000";
    const sig = signed(privateKey, ts, '{"type":1}');
    expect(verifyInteractionSignature('{"type":2}', sig, ts, publicKeyHex)).toBe(false);
  });

  it("rejects a tampered timestamp", () => {
    const { publicKeyHex, privateKey } = makeKeys();
    const body = '{"type":1}';
    const sig = signed(privateKey, "1700000000", body);
    expect(verifyInteractionSignature(body, sig, "1700000001", publicKeyHex)).toBe(false);
  });

  it("rejects a signature from a different key", () => {
    const a = makeKeys();
    const b = makeKeys();
    const ts = "1700000000";
    const body = '{"type":1}';
    const sig = signed(a.privateKey, ts, body);
    expect(verifyInteractionSignature(body, sig, ts, b.publicKeyHex)).toBe(false);
  });

  it("rejects malformed inputs without throwing", () => {
    const { publicKeyHex } = makeKeys();
    expect(verifyInteractionSignature("{}", null, "1", publicKeyHex)).toBe(false);
    expect(verifyInteractionSignature("{}", "abc", null, publicKeyHex)).toBe(false);
    expect(verifyInteractionSignature("{}", "zz", "1", publicKeyHex)).toBe(false); // non-hex
    expect(verifyInteractionSignature("{}", "ab".repeat(64), "1", "shortkey")).toBe(false);
    expect(verifyInteractionSignature("{}", "ab".repeat(64), "1", publicKeyHex)).toBe(false); // valid shape, wrong sig
  });
});
