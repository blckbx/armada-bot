import { nip19 } from "nostr-tools";
import { describe, expect, it } from "vitest";
import { IdentityResolutionError, parseResolvedNsec } from "../identity.js";
import { TEST_NPUB, TEST_NSEC, TEST_PUBLIC_KEY } from "./helpers.js";

describe("resolved bot identity", () => {
  it("derives only stable public identifiers from a valid resolved nsec", () => {
    const identity = parseResolvedNsec(TEST_NSEC);
    expect(identity.publicKey).toBe(TEST_PUBLIC_KEY);
    expect(identity.npub).toBe(TEST_NPUB);
    expect(identity.secretKey).toHaveLength(32);
  });

  it.each([
    "0".repeat(64),
    `${TEST_NSEC}\n`,
    ` ${TEST_NSEC}`,
    `${TEST_NSEC} extra`,
    "npub1invalid",
    "nsec1invalid",
    "x".repeat(257),
  ])("rejects invalid secret input with a sanitized error", (value) => {
    expect(() => parseResolvedNsec(value)).toThrow(IdentityResolutionError);
    try {
      parseResolvedNsec(value);
    } catch (error) {
      expect(String(error)).not.toContain(value);
    }
  });

  it("rejects zero and out-of-range secp256k1 scalars", () => {
    const zero = nip19.nsecEncode(new Uint8Array(32));
    const order = Uint8Array.from(
      Buffer.from(
        "fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141",
        "hex",
      ),
    );
    expect(() => parseResolvedNsec(zero)).toThrow(IdentityResolutionError);
    expect(() => parseResolvedNsec(nip19.nsecEncode(order))).toThrow(
      IdentityResolutionError,
    );
  });
});
