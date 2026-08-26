import { nip19 } from "nostr-tools";
import { verifyEvent, type NostrEvent } from "nostr-tools/pure";
import { afterEach, describe, expect, it } from "vitest";
import {
  createInboxAnnouncement,
  RelayManager,
  RelayTransportError,
  verifyInboxAnnouncement,
} from "../relay-manager.js";
import {
  BOT_PUBLIC_KEY,
  BOT_SECRET_KEY,
  createArmadaFixture,
  FIXTURE_NOW,
} from "./nip17-fixtures.js";
import { LoopbackRelay } from "./loopback-relay.js";

const relays: LoopbackRelay[] = [];

afterEach(async () => {
  await Promise.all(relays.splice(0).map(async (relay) => relay.stop()));
});

function createManager(
  inboxRelays: string[],
  overrides: Partial<ConstructorParameters<typeof RelayManager>[0]> = {},
): RelayManager {
  return new RelayManager({
    inboxRelays,
    discoveryRelays: inboxRelays,
    publishInbox: false,
    allowPrivateRelays: true,
    identity: { secretKey: BOT_SECRET_KEY, publicKey: BOT_PUBLIC_KEY },
    recoveryLookbackSeconds: 3_600,
    maxMessageAgeSeconds: 86_400,
    maxFutureSkewSeconds: 300,
    nowSeconds: () => FIXTURE_NOW,
    onEvent: () => undefined,
    ...overrides,
  });
}

describe("relay manager", () => {
  it("starts multiple inbox relays concurrently and isolates failures", async () => {
    const healthy = new LoopbackRelay();
    relays.push(healthy);
    await healthy.start();
    const manager = createManager([healthy.url, "ws://127.0.0.1:9/"]);

    await manager.start();
    await eventually(() => manager.snapshot().liveSubscriptions === 1);

    expect(manager.snapshot()).toMatchObject({
      running: true,
      ready: true,
      health: "degraded",
      liveSubscriptions: 1,
      configuredInboxRelays: 2,
      connectedInboxRelays: 1,
      dedupeAvailable: true,
      partiallyAvailable: true,
    });
    expect(manager.snapshot().relays).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ relayUrl: healthy.url, state: "connected" }),
        expect.objectContaining({
          relayUrl: "ws://127.0.0.1:9/",
          state: "reconnecting",
        }),
      ]),
    );
    expect(healthy.requests[0]?.filter).toEqual({
      kinds: [1059],
      "#p": [BOT_PUBLIC_KEY],
      since: FIXTURE_NOW - 3_600 - 172_800,
    });
    await manager.stop();
  });

  it("publishes and reads back a verified kind-10050 through at least one relay", async () => {
    const accepting = new LoopbackRelay({ requireAuth: true });
    const rejecting = new LoopbackRelay({ rejectEvents: true });
    relays.push(accepting, rejecting);
    await Promise.all([accepting.start(), rejecting.start()]);
    const manager = createManager([accepting.url, rejecting.url], {
      publishInbox: true,
    });

    await manager.start();
    await eventually(() => manager.snapshot().ready);

    const announcement = accepting.publishedEvents.find(
      (event) => event.kind === 10_050,
    );
    expect(announcement).toBeDefined();
    expect(announcement?.pubkey).toBe(BOT_PUBLIC_KEY);
    expect(announcement?.content).toBe("");
    expect(announcement?.tags).toEqual([
      ["relay", accepting.url],
      ["relay", rejecting.url],
    ]);
    expect(
      announcement === undefined
        ? false
        : verifyEvent(cloneEvent(announcement)),
    ).toBe(true);
    expect(JSON.stringify(announcement)).not.toContain(
      nip19.nsecEncode(BOT_SECRET_KEY),
    );
    expect(accepting.storedEvents.every((event) => event.kind !== 22_242)).toBe(
      true,
    );
    const snapshot = manager.snapshot();
    expect(snapshot).toMatchObject({
      ready: true,
      health: "healthy",
      announcementVerified: true,
    });
    expect(snapshot.lastError).toBeUndefined();
    await manager.stop();
  });

  it("degrades readiness when no relay accepts the inbox announcement", async () => {
    const rejecting = new LoopbackRelay({ rejectEvents: true });
    relays.push(rejecting);
    await rejecting.start();
    const manager = createManager([rejecting.url], { publishInbox: true });

    await manager.start();
    await eventually(() => manager.snapshot().liveSubscriptions === 1);

    expect(manager.snapshot()).toMatchObject({
      running: true,
      ready: false,
      health: "degraded",
      announcementVerified: false,
      lastError: "Relay publication failed.",
    });
    await manager.stop();
  });

  it("reports replay persistence degradation as a sanitized probe field", async () => {
    const relay = new LoopbackRelay();
    relays.push(relay);
    await relay.start();
    const manager = createManager([relay.url]);
    await manager.start();
    await eventually(() => manager.snapshot().ready);

    manager.markIntakeDegraded();

    expect(manager.snapshot()).toMatchObject({
      ready: false,
      health: "degraded",
      dedupeAvailable: false,
      lastError: "Replay protection is unavailable.",
    });
    await manager.stop();
  });

  it("publishes successfully with one valid OK and fails with none", async () => {
    const accepting = new LoopbackRelay();
    const rejecting = new LoopbackRelay({ rejectEvents: true });
    relays.push(accepting, rejecting);
    await Promise.all([accepting.start(), rejecting.start()]);
    const manager = createManager([accepting.url, rejecting.url]);
    await manager.start();
    const event = createInboxAnnouncement({
      secretKey: BOT_SECRET_KEY,
      inboxRelays: [accepting.url],
      now: FIXTURE_NOW,
    });

    await expect(
      manager.publishToAtLeastOne([accepting.url, rejecting.url], event),
    ).resolves.toEqual({
      successfulRelays: [accepting.url],
      failedRelayCount: 1,
    });
    await expect(
      manager.publishToAtLeastOne([rejecting.url], event),
    ).rejects.toThrow(RelayTransportError);
    await manager.stop();
  });

  it("rejects oversized recipient fan-out and query relay sets", async () => {
    const relay = new LoopbackRelay();
    relays.push(relay);
    await relay.start();
    const manager = createManager([relay.url]);
    await manager.start();
    await eventually(() => manager.snapshot().ready);
    const event = createInboxAnnouncement({
      secretKey: BOT_SECRET_KEY,
      inboxRelays: [relay.url],
      now: FIXTURE_NOW,
    });

    await expect(
      manager.publishToAtLeastOne(
        Array.from(
          { length: 4 },
          (_, index) => `wss://recipient-${String(index)}.example/`,
        ),
        event,
        { source: "recipient" },
      ),
    ).rejects.toThrow(RelayTransportError);
    await expect(
      manager.queryRelays(
        Array.from(
          { length: 9 },
          (_, index) => `wss://discovery-${String(index)}.example/`,
        ),
        { kinds: [10_050] },
      ),
    ).rejects.toThrow(RelayTransportError);
    await manager.stop();
  });

  it("bounds raw-event handoff and prevents queued or late delivery after stop", async () => {
    const relay = new LoopbackRelay();
    relays.push(relay);
    await relay.start();
    let releaseHandler: (() => void) | undefined;
    const handled: string[] = [];
    const manager = createManager([relay.url], {
      limits: { pendingInboundEvents: 1, concurrentInboundHandlers: 1 },
      onEvent: async (event) => {
        handled.push(event.id);
        await new Promise<void>((resolve) => {
          releaseHandler = resolve;
        });
      },
    });
    await manager.start();
    await eventually(() => manager.snapshot().liveSubscriptions === 1);

    relay.sendEvent(createArmadaFixture());
    relay.sendEvent(createArmadaFixture());
    relay.sendEvent(createArmadaFixture());
    await eventually(() => releaseHandler !== undefined);
    await eventually(() => manager.snapshot().droppedInboundEvents === 1);
    const stop = manager.stop();
    relay.sendEvent(createArmadaFixture());
    releaseHandler?.();
    await stop;

    expect(handled).toHaveLength(1);
    expect(manager.snapshot()).toMatchObject({
      running: false,
      ready: false,
      queuedInboundEvents: 0,
    });
  });

  it("serializes the default single-owner inbound queue", async () => {
    const relay = new LoopbackRelay();
    relays.push(relay);
    await relay.start();
    let releaseFirst: (() => void) | undefined;
    let calls = 0;
    const manager = createManager([relay.url], {
      onEvent: async () => {
        calls += 1;
        if (calls === 1) {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        }
      },
    });
    await manager.start();
    await eventually(() => manager.snapshot().ready);

    relay.sendEvent(createArmadaFixture());
    relay.sendEvent(
      createArmadaFixture({
        wrapTemplate: { created_at: FIXTURE_NOW - 2_401 },
      }),
    );
    relay.sendEvent(
      createArmadaFixture({
        wrapTemplate: { created_at: FIXTURE_NOW - 2_402 },
      }),
    );
    await eventually(() => manager.snapshot().queuedInboundEvents === 2);

    expect(manager.snapshot()).toMatchObject({
      activeInboundHandlers: 1,
      queuedInboundEvents: 2,
    });

    releaseFirst?.();
    await eventually(() => calls === 3);
    await eventually(() => manager.snapshot().activeInboundHandlers === 0);
    await manager.stop();
  });

  it("reports inbound handler failures without sensitive error details", async () => {
    const relay = new LoopbackRelay();
    relays.push(relay);
    await relay.start();
    const manager = createManager([relay.url], {
      onEvent: () => Promise.reject(new Error("sensitive handler details")),
    });
    await manager.start();
    await eventually(() => manager.snapshot().ready);

    relay.sendEvent(createArmadaFixture());
    await eventually(() => manager.snapshot().failedInboundEvents === 1);

    expect(manager.snapshot()).toMatchObject({
      ready: true,
      failedInboundEvents: 1,
      health: "degraded",
      lastError: "Inbound message processing failed.",
    });
    expect(JSON.stringify(manager.snapshot())).not.toContain(
      "sensitive handler details",
    );
    await manager.stop();
  });

  it("surfaces authenticated rate limiting without sensitive details", async () => {
    const relay = new LoopbackRelay();
    relays.push(relay);
    await relay.start();
    const manager = createManager([relay.url]);
    await manager.start();
    await eventually(() => manager.snapshot().ready);

    manager.markInboundRateLimited();
    manager.markInboundRateLimited();

    expect(manager.snapshot()).toMatchObject({
      rateLimitedInboundEvents: 2,
      health: "healthy",
    });
    expect(JSON.stringify(manager.snapshot())).not.toContain(BOT_PUBLIC_KEY);
    await manager.stop();
  });

  it("strictly verifies bot-authored inbox announcements", () => {
    const relayUrls = ["wss://relay.ditto.pub/", "wss://relay.dreamith.to/"];
    const event = createInboxAnnouncement({
      secretKey: BOT_SECRET_KEY,
      inboxRelays: relayUrls,
      now: FIXTURE_NOW,
    });

    expect(
      verifyInboxAnnouncement(event, {
        botPublicKey: BOT_PUBLIC_KEY,
        inboxRelays: relayUrls,
        now: FIXTURE_NOW,
        maxFutureSkewSeconds: 300,
      }),
    ).toBe(true);
    const reversed = createInboxAnnouncement({
      secretKey: BOT_SECRET_KEY,
      inboxRelays: [...relayUrls].reverse(),
      now: FIXTURE_NOW,
    });
    expect(
      verifyInboxAnnouncement(reversed, {
        botPublicKey: BOT_PUBLIC_KEY,
        inboxRelays: relayUrls,
        now: FIXTURE_NOW,
        maxFutureSkewSeconds: 300,
      }),
    ).toBe(true);
    expect(
      verifyInboxAnnouncement(
        { ...event, id: "0".repeat(64) },
        {
          botPublicKey: BOT_PUBLIC_KEY,
          inboxRelays: relayUrls,
          now: FIXTURE_NOW,
          maxFutureSkewSeconds: 300,
        },
      ),
    ).toBe(false);
    expect(
      verifyInboxAnnouncement(event, {
        botPublicKey: BOT_PUBLIC_KEY,
        inboxRelays: [relayUrls[0] ?? ""],
        now: FIXTURE_NOW,
        maxFutureSkewSeconds: 300,
      }),
    ).toBe(false);
  });
});

async function eventually(
  predicate: () => boolean,
  attempts = 200,
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition was not met");
}

function cloneEvent(event: NostrEvent): NostrEvent {
  return {
    kind: event.kind,
    tags: event.tags.map((tag) => [...tag]),
    content: event.content,
    created_at: event.created_at,
    pubkey: event.pubkey,
    id: event.id,
    sig: event.sig,
  };
}
