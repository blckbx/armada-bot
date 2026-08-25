import type { RawData } from "ws";
import WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInboundProcessor } from "../inbound.js";
import { createInboxAnnouncement, RelayManager } from "../relay-manager.js";
import type { RelayConnector } from "../relay-session.js";
import { RecipientRelayRouter } from "../relay-routing.js";
import { ClaimableReplayGate } from "../replay-gate.js";
import {
  BOT_PUBLIC_KEY,
  BOT_SECRET_KEY,
  createArmadaFixture,
  FIXTURE_NOW,
  independentlyOpenWrap,
  SENDER_PUBLIC_KEY,
  SENDER_SECRET_KEY,
} from "./nip17-fixtures.js";
import { LoopbackRelay } from "./loopback-relay.js";

const relays: LoopbackRelay[] = [];
const INBOX_RELAY = "wss://inbox.example/";
const DISCOVERY_RELAY = "wss://discovery.example/";
const RECIPIENT_RELAY = "wss://recipient.example/";
const PUBLIC_DNS = () =>
  Promise.resolve([{ address: "93.184.216.34", family: 4 as const }]);

afterEach(async () => {
  await Promise.all(relays.splice(0).map(async (relay) => relay.stop()));
});

describe("Slice 6 conversation-bound encrypted loopback", () => {
  it.each([
    {
      label: "authoritative owner kind-10050",
      publishOwnerAnnouncement: true,
      expectedDeliveryRelay: RECIPIENT_RELAY,
    },
    {
      label: "automatic configured-relay fallback",
      publishOwnerAnnouncement: false,
      expectedDeliveryRelay: INBOX_RELAY,
    },
  ])(
    "runs user -> relay -> OpenClaw -> $label -> user decrypt",
    async ({ publishOwnerAnnouncement, expectedDeliveryRelay }) => {
      const relay = new LoopbackRelay();
      relays.push(relay);
      await relay.start();
      if (publishOwnerAnnouncement) {
        relay.storedEvents.push(
          createInboxAnnouncement({
            secretKey: SENDER_SECRET_KEY,
            inboxRelays: [RECIPIENT_RELAY],
            now: FIXTURE_NOW,
          }),
        );
      }
      const connectedTargets: string[] = [];
      const connector = connectorTo(relay.url, connectedTargets);
      const managerHolder: { value?: RelayManager } = {};
      const router = new RecipientRelayRouter({
        discoveryRelays: [DISCOVERY_RELAY],
        fallbackRelays: [INBOX_RELAY],
        allowFallbackDelivery: true,
        maxFutureSkewSeconds: 300,
        query: (relayUrls, filter) =>
          managerHolder.value?.queryRelays(relayUrls, filter) ??
          Promise.reject(new Error("manager unavailable")),
        lookup: PUBLIC_DNS,
        nowSeconds: () => FIXTURE_NOW,
      });
      const dispatch = vi.fn(async (params: never) => {
        await (
          params as { deliver: (payload: unknown) => Promise<void> }
        ).deliver({ text: "loopback agent answer" });
        return {} as never;
      });
      const processor = createInboundProcessor({
        cfg: {},
        runtime: {} as never,
        accountId: "default",
        config: {
          dmPolicy: "allowlist",
          allowFrom: [SENDER_PUBLIC_KEY],
          maxMessageAgeSeconds: 3_600,
          maxFutureSkewSeconds: 300,
        },
        identity: { secretKey: BOT_SECRET_KEY, publicKey: BOT_PUBLIC_KEY },
        replayGate: new ClaimableReplayGate({
          accountId: "default",
          botPublicKey: BOT_PUBLIC_KEY,
          maxMessageAgeSeconds: 3_600,
          dedupe: createMemoryDedupe(),
        }),
        resolveRecipientRelays: (recipient) => router.resolve(recipient),
        publishRecipient: (relayUrls, event) =>
          managerHolder.value?.publishToAtLeastOne(relayUrls, event, {
            source: "recipient",
          }) ?? Promise.reject(new Error("manager unavailable")),
        publishSelfCopy: (event) =>
          managerHolder.value?.publishToAtLeastOne([INBOX_RELAY], event, {
            source: "configured",
          }) ?? Promise.reject(new Error("manager unavailable")),
        resolveIngress: () =>
          Promise.resolve({
            senderAccess: { decision: "allow" },
            commandAccess: { requested: false, authorized: false },
          } as never),
        dispatch,
        nowSeconds: () => FIXTURE_NOW,
      });
      const manager = new RelayManager({
        inboxRelays: [INBOX_RELAY],
        discoveryRelays: [DISCOVERY_RELAY],
        publishInbox: false,
        allowPrivateRelays: false,
        identity: { secretKey: BOT_SECRET_KEY, publicKey: BOT_PUBLIC_KEY },
        recoveryLookbackSeconds: 3_600,
        maxMessageAgeSeconds: 3_600,
        maxFutureSkewSeconds: 300,
        onEvent: (event) => processor.handle(event).then(() => undefined),
        lookup: PUBLIC_DNS,
        connector,
        nowSeconds: () => FIXTURE_NOW,
      });
      managerHolder.value = manager;

      await manager.start();
      await eventually(() => manager.snapshot().liveSubscriptions === 1);
      const inbound = createArmadaFixture();
      relay.sendEvent(inbound);
      await eventually(
        () =>
          relay.publishedEvents.filter((event) => event.kind === 1059)
            .length === 2,
        300,
      );

      expect(dispatch).toHaveBeenCalledOnce();
      const response = relay.publishedEvents.find(
        (event) =>
          event.kind === 1059 &&
          event.tags.some(
            (tag) => tag[0] === "p" && tag[1] === SENDER_PUBLIC_KEY,
          ),
      );
      const recoveryCopy = relay.publishedEvents.find(
        (event) =>
          event.kind === 1059 &&
          event.tags.some((tag) => tag[0] === "p" && tag[1] === BOT_PUBLIC_KEY),
      );
      expect(response).toBeDefined();
      expect(recoveryCopy).toBeDefined();
      if (response === undefined || recoveryCopy === undefined) {
        throw new Error("missing response copy");
      }
      const opened = independentlyOpenWrap(response, SENDER_SECRET_KEY);
      const recovered = independentlyOpenWrap(recoveryCopy, BOT_SECRET_KEY);
      expect(opened.rumor).toMatchObject({
        pubkey: BOT_PUBLIC_KEY,
        content: "loopback agent answer",
        tags: [
          ["p", SENDER_PUBLIC_KEY],
          ["e", independentlyOpenWrap(inbound, BOT_SECRET_KEY).rumor.id],
        ],
      });
      expect(recovered.rumor).toEqual(opened.rumor);
      expect(recoveryCopy.id).not.toBe(response.id);
      const recipientConnections = relay.requests.filter(
        (request) => request.filter["authors"] !== undefined,
      );
      expect(recipientConnections).toHaveLength(1);
      expect(connectedTargets).toContain(expectedDeliveryRelay);
      await manager.stop();
    },
  );
});

function connectorTo(url: string, connectedTargets: string[]): RelayConnector {
  return (target, handlers, signal) =>
    new Promise((resolve, reject) => {
      connectedTargets.push(target.url);
      const socket = new WebSocket(url);
      const abort = () => socket.terminate();
      signal.addEventListener("abort", abort, { once: true });
      socket.on("message", (data: RawData) =>
        handlers.onMessage(rawDataToString(data)),
      );
      socket.on("close", () => handlers.onClose());
      socket.on("error", () => handlers.onError());
      socket.on("open", () =>
        resolve({
          send: (frame) => socket.send(frame),
          close: () => socket.close(),
        }),
      );
      socket.on("error", reject);
    });
}

function createMemoryDedupe() {
  const committed = new Set<string>();
  const inflight = new Set<string>();
  return {
    claim(key: string) {
      if (committed.has(key))
        return Promise.resolve({ kind: "duplicate" as const });
      if (inflight.has(key))
        return Promise.resolve({ kind: "duplicate" as const });
      inflight.add(key);
      return Promise.resolve({ kind: "claimed" as const });
    },
    commit(key: string) {
      inflight.delete(key);
      committed.add(key);
      return Promise.resolve(true);
    },
    release(key: string) {
      inflight.delete(key);
    },
  };
}

function rawDataToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}

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
