import { setImmediate as waitImmediate } from "node:timers/promises";
import {
  finalizeEvent,
  verifyEvent,
  type EventTemplate,
  type NostrEvent,
} from "nostr-tools/pure";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RelaySession, type RelaySessionSnapshot } from "../relay-session.js";
import { createInboxAnnouncement } from "../relay-manager.js";
import {
  BOT_PUBLIC_KEY,
  BOT_SECRET_KEY,
  createArmadaFixture,
  FIXTURE_NOW,
  resignWrap,
} from "./nip17-fixtures.js";
import { LoopbackRelay } from "./loopback-relay.js";

const relays: LoopbackRelay[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(relays.splice(0).map(async (relay) => relay.stop()));
});

function createSession(
  relay: LoopbackRelay,
  overrides: Partial<ConstructorParameters<typeof RelaySession>[0]> = {},
) {
  const events: NostrEvent[] = [];
  const snapshots: RelaySessionSnapshot[] = [];
  const session = new RelaySession({
    relayUrl: relay.url,
    identity: { secretKey: BOT_SECRET_KEY, publicKey: BOT_PUBLIC_KEY },
    allowPrivateRelays: true,
    subscription: {
      recipientPublicKey: BOT_PUBLIC_KEY,
      since: FIXTURE_NOW - 4_000,
      maxMessageAgeSeconds: 86_400,
      maxFutureSkewSeconds: 300,
    },
    nowSeconds: () => FIXTURE_NOW,
    nowMilliseconds: () => FIXTURE_NOW * 1_000,
    random: () => 0,
    onEvent: (event) => {
      events.push(event);
    },
    onStatus: (snapshot) => snapshots.push(snapshot),
    ...overrides,
  });
  return { session, events, snapshots };
}

describe("relay session", () => {
  it("subscribes only to bounded bot-addressed gift wraps", async () => {
    const relay = new LoopbackRelay();
    relays.push(relay);
    await relay.start();
    const { session } = createSession(relay);

    await session.start();
    await eventually(() => session.snapshot().subscriptionLive);

    expect(relay.requests).toHaveLength(1);
    expect(relay.requests[0]?.filter).toEqual({
      kinds: [1059],
      "#p": [BOT_PUBLIC_KEY],
      since: FIXTURE_NOW - 4_000,
    });
    await session.stop();
    await eventually(() => relay.closedSubscriptions.length === 1);
  });

  it("admits only valid relevant outer events and survives handler rejection", async () => {
    const relay = new LoopbackRelay();
    relays.push(relay);
    await relay.start();
    let calls = 0;
    const { session } = createSession(relay, {
      onEvent: () => {
        calls += 1;
        return calls === 1
          ? Promise.reject(new Error("sensitive handler failure"))
          : Promise.resolve();
      },
    });
    await session.start();
    await eventually(() => session.snapshot().subscriptionLive);

    const subscriptionId = relay.requests[0]?.subscriptionId ?? "missing";
    relay.sendRaw(["EVENT", subscriptionId, { malformed: true }]);
    relay.sendRaw([
      "EVENT",
      subscriptionId,
      resignWrap(createArmadaFixture(), { kind: 1 }),
    ]);
    relay.sendEvent(createArmadaFixture());
    await eventually(() => calls === 1);
    relay.sendEvent(createArmadaFixture());
    await eventually(() => calls === 2);

    expect(session.snapshot().state).toBe("connected");
    expect(session.snapshot().subscriptionLive).toBe(true);
    await session.stop();
  });

  it("signs connection-scoped NIP-42 AUTH and restores the subscription", async () => {
    const relay = new LoopbackRelay({ requireAuth: true });
    relays.push(relay);
    await relay.start();
    const { session } = createSession(relay);

    await session.start();
    await eventually(() => session.snapshot().subscriptionLive);

    expect(relay.authEvents).toHaveLength(1);
    const auth = relay.authEvents[0];
    expect(auth?.kind).toBe(22_242);
    expect(auth?.pubkey).toBe(BOT_PUBLIC_KEY);
    expect(auth?.content).toBe("");
    expect(auth?.tags).toContainEqual(["relay", relay.url]);
    expect(auth?.tags).toContainEqual(["challenge", "loopback-challenge-1"]);
    expect(auth === undefined ? false : verifyEvent(cloneEvent(auth))).toBe(
      true,
    );
    expect(relay.requests.length).toBeGreaterThanOrEqual(2);
    await session.stop();
  });

  it("never crosses AUTH challenges or relay tags between simultaneous connections", async () => {
    const firstRelay = new LoopbackRelay({ requireAuth: true });
    const secondRelay = new LoopbackRelay({ requireAuth: true });
    relays.push(firstRelay, secondRelay);
    await Promise.all([firstRelay.start(), secondRelay.start()]);
    const first = createSession(firstRelay).session;
    const second = createSession(secondRelay).session;

    await Promise.all([first.start(), second.start()]);
    await eventually(
      () =>
        first.snapshot().subscriptionLive && second.snapshot().subscriptionLive,
    );

    expect(firstRelay.authEvents[0]?.tags).toContainEqual([
      "relay",
      firstRelay.url,
    ]);
    expect(firstRelay.authEvents[0]?.tags).not.toContainEqual([
      "relay",
      secondRelay.url,
    ]);
    expect(secondRelay.authEvents[0]?.tags).toContainEqual([
      "relay",
      secondRelay.url,
    ]);
    expect(secondRelay.authEvents[0]?.tags).not.toContainEqual([
      "relay",
      firstRelay.url,
    ]);
    await Promise.all([first.stop(), second.stop()]);
  });

  it("does not send replaced or expired challenges after delayed signing", async () => {
    const relay = new LoopbackRelay({ requireAuth: true });
    relays.push(relay);
    await relay.start();
    let currentMilliseconds = FIXTURE_NOW * 1_000;
    let releaseFirst: (() => void) | undefined;
    let releaseThird: (() => void) | undefined;
    let signCalls = 0;
    const { session } = createSession(relay, {
      nowMilliseconds: () => currentMilliseconds,
      signAuthEvent: async (template: EventTemplate) => {
        signCalls += 1;
        if (signCalls === 1) {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        }
        if (signCalls === 3) {
          await new Promise<void>((resolve) => {
            releaseThird = resolve;
          });
        }
        return finalizeEvent(template, BOT_SECRET_KEY);
      },
    });

    await session.start();
    await eventually(() => releaseFirst !== undefined);
    relay.replaceChallenge("replacement");
    await eventually(() => relay.authEvents.length === 1);
    releaseFirst?.();
    await waitImmediate();
    expect(relay.authEvents).toHaveLength(1);
    expect(relay.authEvents[0]?.tags).toContainEqual([
      "challenge",
      "replacement",
    ]);

    relay.replaceChallenge("expires-before-signing");
    await eventually(() => signCalls === 3);
    currentMilliseconds += 5_001;
    releaseThird?.();
    await waitImmediate();
    expect(relay.authEvents).toHaveLength(1);
    await session.stop();
  });

  it("never signs or connects to a private destination rejected by policy", async () => {
    const relay = new LoopbackRelay({ requireAuth: true });
    relays.push(relay);
    await relay.start();
    const signer = vi.fn((template: EventTemplate) =>
      Promise.resolve(finalizeEvent(template, BOT_SECRET_KEY)),
    );
    const { session } = createSession(relay, {
      allowPrivateRelays: false,
      signAuthEvent: signer,
    });

    await session.start();
    expect(session.snapshot()).toMatchObject({
      state: "disconnected",
      lastError: "Relay connection failed.",
    });
    expect(signer).not.toHaveBeenCalled();
    expect(relay.connectionCount).toBe(0);
    await session.stop();
  });

  it("reconnects with bounded backoff and restores one AUTH subscription", async () => {
    const relay = new LoopbackRelay({ requireAuth: true });
    relays.push(relay);
    await relay.start();
    const { session } = createSession(relay);
    await session.start();
    await eventually(() => session.snapshot().subscriptionLive);

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    relay.disconnectAll();
    await eventuallyImmediate(
      () => session.snapshot().state === "reconnecting",
    );
    expect(session.snapshot().reconnectAttempts).toBe(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(relay.authEvents).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await eventuallyImmediate(() => session.snapshot().subscriptionLive);

    expect(relay.authEvents).toHaveLength(2);
    expect(
      relay.requests.filter((request) => request.filter["kinds"] !== undefined),
    ).toHaveLength(4);
    expect(session.snapshot().reconnectAttempts).toBe(1);
    await session.stop();
    const requestsAfterStop = relay.requests.length;
    await vi.runAllTimersAsync();
    expect(relay.requests).toHaveLength(requestsAfterStop);
  });

  it("starts and stops idempotently without multiplying handlers", async () => {
    const relay = new LoopbackRelay();
    relays.push(relay);
    await relay.start();
    const { session } = createSession(relay);

    await Promise.all([session.start(), session.start()]);
    await eventually(() => session.snapshot().subscriptionLive);
    expect(relay.requests).toHaveLength(1);
    await Promise.all([session.stop(), session.stop()]);
    expect(session.snapshot().state).toBe("disconnected");
  });

  it("bounds events accumulated from a malicious query response", async () => {
    const relay = new LoopbackRelay();
    relays.push(relay);
    await relay.start();
    for (let index = 0; index < 5; index += 1) {
      relay.storedEvents.push(
        createInboxAnnouncement({
          secretKey: BOT_SECRET_KEY,
          inboxRelays: [`wss://relay-${String(index)}.example/`],
          now: FIXTURE_NOW - index,
        }),
      );
    }
    const { session } = createSession(relay, {
      limits: { queryResultEvents: 2 },
    });
    await session.start();
    await eventually(() => session.snapshot().subscriptionLive);

    await expect(
      session.query({ kinds: [10_050], authors: [BOT_PUBLIC_KEY] }),
    ).resolves.toHaveLength(2);
    await session.stop();
  });
});

async function eventually(
  predicate: () => boolean,
  attempts = 100,
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition was not met");
}

async function eventuallyImmediate(
  predicate: () => boolean,
  attempts = 100,
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await waitImmediate();
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
