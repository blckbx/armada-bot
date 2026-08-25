import { describe, expect, it, vi } from "vitest";
import {
  RelayUrlPolicyError,
  validateRelayUrl,
  type RelayDnsLookup,
} from "../relay-url-policy.js";
import { SECURITY_LIMITS } from "../security-limits.js";

const publicLookup: RelayDnsLookup = () =>
  Promise.resolve([{ address: "93.184.216.34", family: 4 }]);

describe("relay URL and network policy", () => {
  it("normalizes a public relay and pins a policy-approved address", async () => {
    const lookup = vi.fn(publicLookup);
    await expect(
      validateRelayUrl({
        url: "wss://Relay.Example/path",
        source: "configured",
        allowPrivateRelays: false,
        lookup,
      }),
    ).resolves.toEqual({
      url: "wss://relay.example/path",
      hostname: "relay.example",
      address: "93.184.216.34",
      family: 4,
    });
    expect(lookup).toHaveBeenCalledWith("relay.example");
  });

  it.each([
    "https://relay.example/",
    "wss://user:password@relay.example/",
    "wss://relay.example/#fragment",
    "wss://relay.example/\n",
    `wss://relay.example/${"x".repeat(SECURITY_LIMITS.relayUrlBytes)}`,
    "wss://relay.example./",
  ])("rejects malformed or non-canonical configured URL %s", async (url) => {
    await expect(
      validateRelayUrl({
        url,
        source: "configured",
        allowPrivateRelays: false,
        lookup: publicLookup,
      }),
    ).rejects.toThrow(RelayUrlPolicyError);
  });

  it("rejects every private DNS answer unless configuration explicitly consents", async () => {
    const privateLookup: RelayDnsLookup = () =>
      Promise.resolve([
        { address: "93.184.216.34", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ]);
    await expect(
      validateRelayUrl({
        url: "wss://relay.example/",
        source: "configured",
        allowPrivateRelays: false,
        lookup: privateLookup,
      }),
    ).rejects.toThrow(RelayUrlPolicyError);
    await expect(
      validateRelayUrl({
        url: "ws://127.0.0.1:9000/",
        source: "configured",
        allowPrivateRelays: true,
      }),
    ).resolves.toMatchObject({ address: "127.0.0.1", family: 4 });
  });

  it("never relaxes recipient-provided relay policy", async () => {
    await expect(
      validateRelayUrl({
        url: "ws://relay.example/",
        source: "recipient",
        allowPrivateRelays: true,
        lookup: publicLookup,
      }),
    ).rejects.toThrow(RelayUrlPolicyError);
    await expect(
      validateRelayUrl({
        url: "wss://relay.example/",
        source: "recipient",
        allowPrivateRelays: true,
        lookup: () => Promise.resolve([{ address: "10.0.0.1", family: 4 }]),
      }),
    ).rejects.toThrow(RelayUrlPolicyError);
  });
});
