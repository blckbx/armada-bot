import { finalizeEvent, type NostrEvent } from "nostr-tools/pure";
import { describe, expect, it, vi } from "vitest";
import {
  RecipientRelayRoutingError,
  RecipientRelayRouter,
} from "../relay-routing.js";
import {
  FIXTURE_NOW,
  OTHER_PUBLIC_KEY,
  OTHER_SECRET_KEY,
  SENDER_PUBLIC_KEY,
  SENDER_SECRET_KEY,
} from "./nip17-fixtures.js";

const PUBLIC_DNS = () =>
  Promise.resolve([{ address: "93.184.216.34", family: 4 as const }]);

function announcement(
  createdAt: number,
  relays: string[],
  secretKey = SENDER_SECRET_KEY,
): NostrEvent {
  return finalizeEvent(
    {
      kind: 10_050,
      content: "",
      tags: relays.map((relay) => ["relay", relay]),
      created_at: createdAt,
    },
    secretKey,
  );
}

describe("recipient relay routing", () => {
  it("uses only the newest valid signed recipient list and caches it", async () => {
    const query = vi.fn(() =>
      Promise.resolve([
        announcement(FIXTURE_NOW - 10, ["wss://old.example"]),
        announcement(FIXTURE_NOW, [
          "wss://one.example",
          "wss://one.example/",
          "https://ignored.example",
          "wss://two.example/path",
        ]),
      ]),
    );
    const router = new RecipientRelayRouter({
      discoveryRelays: ["wss://discovery.example/"],
      fallbackRelays: ["wss://fallback.example/"],
      allowFallbackDelivery: false,
      maxFutureSkewSeconds: 300,
      query,
      lookup: PUBLIC_DNS,
      nowSeconds: () => FIXTURE_NOW,
    });

    await expect(router.resolve(SENDER_PUBLIC_KEY)).resolves.toEqual([
      "wss://one.example/",
      "wss://two.example/path",
    ]);
    await expect(router.resolve(SENDER_PUBLIC_KEY)).resolves.toEqual([
      "wss://one.example/",
      "wss://two.example/path",
    ]);
    expect(query).toHaveBeenCalledOnce();
  });

  it("rejects forged, wrong-author, future, empty, private, and missing lists", async () => {
    const forged = {
      ...announcement(FIXTURE_NOW, ["wss://valid.example"]),
      id: "0".repeat(64),
    };
    const router = new RecipientRelayRouter({
      discoveryRelays: ["wss://discovery.example/"],
      fallbackRelays: ["wss://fallback.example/"],
      allowFallbackDelivery: false,
      maxFutureSkewSeconds: 300,
      query: () =>
        Promise.resolve([
          announcement(FIXTURE_NOW, ["wss://wrong.example"], OTHER_SECRET_KEY),
          { ...announcement(FIXTURE_NOW, []), pubkey: OTHER_PUBLIC_KEY },
          announcement(FIXTURE_NOW + 301, ["wss://future.example"]),
          forged,
          announcement(FIXTURE_NOW, ["wss://127.0.0.1"]),
        ]),
      lookup: PUBLIC_DNS,
      nowSeconds: () => FIXTURE_NOW,
    });

    await expect(router.resolve(SENDER_PUBLIC_KEY)).rejects.toThrow(
      RecipientRelayRoutingError,
    );
  });

  it("falls back only when explicitly enabled and never unions fallback relays", async () => {
    const query = vi.fn(() => Promise.resolve([]));
    const router = new RecipientRelayRouter({
      discoveryRelays: ["wss://discovery.example/"],
      fallbackRelays: ["wss://fallback.example/"],
      allowFallbackDelivery: true,
      maxFutureSkewSeconds: 300,
      query,
      lookup: PUBLIC_DNS,
      nowSeconds: () => FIXTURE_NOW,
    });

    await expect(router.resolve(SENDER_PUBLIC_KEY)).resolves.toEqual([
      "wss://fallback.example/",
    ]);
  });
});
