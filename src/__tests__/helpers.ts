import { nip19 } from "nostr-tools";

export const TEST_SECRET_BYTES = Uint8Array.from([
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 1,
]);

export const TEST_NSEC = nip19.nsecEncode(TEST_SECRET_BYTES);
export const TEST_PUBLIC_KEY =
  "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
export const TEST_NPUB = nip19.npubEncode(TEST_PUBLIC_KEY);

export function validConfig(): Record<string, unknown> {
  return {
    secrets: {
      providers: {
        nostr: {
          source: "file",
          path: "/path/to/.openclaw/secrets/nostr_nsec",
          mode: "singleValue",
        },
      },
    },
    channels: {
      nostr: {
        enabled: true,
        name: "OpenClaw",
        privateKey: { source: "file", provider: "nostr", id: "value" },
        relays: [
          "wss://relay.armada.buzz",
          "wss://relay.ditto.pub",
          "wss://relay.dreamith.to",
        ],
        discoveryRelays: ["wss://relay.ditto.pub", "wss://relay.dreamith.to"],
        publishInbox: true,
        allowFallbackDelivery: true,
        allowPrivateRelays: false,
        dmPolicy: "allowlist",
        allowFrom: [TEST_NPUB],
        recoveryLookbackSeconds: 604800,
        maxFutureSkewSeconds: 300,
        maxMessageAgeSeconds: 604800,
        markdown: { tables: "bullets" },
      },
    },
  };
}
