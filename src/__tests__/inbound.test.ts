import type { NostrEvent } from "nostr-tools/pure";
import { createClaimableDedupe } from "openclaw/plugin-sdk/persistent-dedupe";
import { describe, expect, it, vi } from "vitest";
import { createInboundProcessor } from "../inbound.js";
import { createDirectMessage } from "../nip17.js";
import {
  ClaimableReplayGate,
  type ReplayClaim,
  type ReplayGate,
} from "../replay-gate.js";
import {
  BOT_PUBLIC_KEY,
  BOT_SECRET_KEY,
  createArmadaFixture,
  FIXTURE_NOW,
  independentlyOpenWrap,
  OTHER_SECRET_KEY,
  SENDER_PUBLIC_KEY,
  SENDER_SECRET_KEY,
  WRAPPER_SECRET_KEY,
} from "./nip17-fixtures.js";

function allowDecision() {
  return {
    senderAccess: { decision: "allow" },
    commandAccess: { requested: false, authorized: false },
  } as never;
}

function replayGate(): ReplayGate & {
  claims: number;
  commits: number;
  releases: number;
} {
  const gate = {
    claims: 0,
    commits: 0,
    releases: 0,
    degraded: false,
    claim(): Promise<ReplayClaim> {
      gate.claims += 1;
      return Promise.resolve({
        commit: () => {
          gate.commits += 1;
          return Promise.resolve();
        },
        release: () => {
          gate.releases += 1;
        },
      });
    },
  };
  return gate;
}

describe("allowlisted inbound AI round trip", () => {
  it("routes only the authenticated inner sender and returns a decryptable native reply", async () => {
    const ingress = vi.fn(() => Promise.resolve(allowDecision()));
    const published: NostrEvent[] = [];
    const recoveryCopies: NostrEvent[] = [];
    const publish = vi.fn((_relays: string[], event: NostrEvent) => {
      published.push(event);
      return Promise.resolve();
    });
    const dispatch = vi.fn(async (params: never) => {
      const input = params as { deliver: (payload: unknown) => Promise<void> };
      await input.deliver({ text: "mocked OpenClaw answer" });
      return {} as never;
    });
    const gate = replayGate();
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
      replayGate: gate,
      resolveRecipientRelays: () =>
        Promise.resolve(["wss://recipient.example/"]),
      publishRecipient: publish,
      publishSelfCopy: (event) => {
        recoveryCopies.push(event);
        return Promise.resolve();
      },
      resolveIngress: ingress,
      dispatch,
      nowSeconds: () => FIXTURE_NOW,
    });
    const inbound = createArmadaFixture();

    const result = await processor.handle(inbound);

    expect(result).toMatchObject({ handled: true });
    expect(ingress).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: "nostr",
        accountId: "default",
        subject: { stableId: SENDER_PUBLIC_KEY },
        conversation: { kind: "direct", id: SENDER_PUBLIC_KEY },
        dmPolicy: "allowlist",
        allowFrom: [SENDER_PUBLIC_KEY],
        useDefaultPairingStore: false,
      }),
    );
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "nostr",
        accountId: "default",
        peer: { kind: "direct", id: SENDER_PUBLIC_KEY },
        senderId: SENDER_PUBLIC_KEY,
        senderAddress: `nostr:${SENDER_PUBLIC_KEY}`,
        recipientAddress: `nostr:${BOT_PUBLIC_KEY}`,
        rawBody: "armada fixture plaintext",
      }),
    );
    expect(JSON.stringify(ingress.mock.calls)).not.toContain(
      expectOuterPublicKey(WRAPPER_SECRET_KEY),
    );
    expect(JSON.stringify(dispatch.mock.calls)).not.toContain(
      expectOuterPublicKey(WRAPPER_SECRET_KEY),
    );
    expect(publish).toHaveBeenCalledWith(
      ["wss://recipient.example/"],
      expect.objectContaining({ kind: 1059 }),
    );
    const publishedReply = published[0];
    expect(publishedReply).toBeDefined();
    if (publishedReply === undefined) throw new Error("missing reply");
    const reply = independentlyOpenWrap(publishedReply, SENDER_SECRET_KEY);
    expect(reply.rumor).toMatchObject({
      pubkey: BOT_PUBLIC_KEY,
      content: "mocked OpenClaw answer",
      tags: [
        ["p", SENDER_PUBLIC_KEY],
        ["e", expect.any(String)],
      ],
    });
    expect(reply.rumor.tags[1]?.[1]).toBe(
      independentlyOpenWrap(inbound, BOT_SECRET_KEY).rumor.id,
    );
    const recoveryCopy = recoveryCopies[0];
    expect(recoveryCopy).toBeDefined();
    if (recoveryCopy === undefined) throw new Error("missing recovery copy");
    const recovered = independentlyOpenWrap(recoveryCopy, BOT_SECRET_KEY);
    expect(recovered.rumor).toEqual(reply.rumor);
    expect(recoveryCopy.id).not.toBe(publishedReply.id);
    expect(gate.commits).toBe(1);
    expect(gate.releases).toBe(0);
  });

  it("does not dispatch or reply for a sender blocked by OpenClaw ingress", async () => {
    const dispatch = vi.fn();
    const publishRecipient = vi.fn();
    const gate = replayGate();
    const processor = createInboundProcessor({
      cfg: {},
      runtime: {} as never,
      accountId: "default",
      config: {
        dmPolicy: "allowlist",
        allowFrom: [],
        maxMessageAgeSeconds: 3_600,
        maxFutureSkewSeconds: 300,
      },
      identity: { secretKey: BOT_SECRET_KEY, publicKey: BOT_PUBLIC_KEY },
      replayGate: gate,
      resolveRecipientRelays: () => Promise.reject(new Error("not called")),
      publishRecipient,
      publishSelfCopy: vi.fn(),
      resolveIngress: () =>
        Promise.resolve({
          senderAccess: { decision: "block" },
          commandAccess: { requested: false, authorized: false },
        } as never),
      dispatch,
      nowSeconds: () => FIXTURE_NOW,
    });

    await expect(processor.handle(createArmadaFixture())).resolves.toEqual({
      handled: false,
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(publishRecipient).not.toHaveBeenCalled();
    expect(gate.releases).toBe(1);
  });

  it("releases failed turns and resolves destinations before encrypting", async () => {
    const gate = replayGate();
    const createReply = vi.fn();
    const dispatch = vi.fn(async (params: never) => {
      await (
        params as { deliver: (payload: unknown) => Promise<void> }
      ).deliver({ text: "answer" });
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
      replayGate: gate,
      resolveRecipientRelays: () => Promise.reject(new Error("no list")),
      publishRecipient: vi.fn(),
      publishSelfCopy: vi.fn(),
      resolveIngress: () => Promise.resolve(allowDecision()),
      dispatch,
      createReply,
      nowSeconds: () => FIXTURE_NOW,
    });

    await expect(processor.handle(createArmadaFixture())).rejects.toThrow(
      "Direct message delivery failed.",
    );
    expect(createReply).not.toHaveBeenCalled();
    expect(gate.commits).toBe(0);
    expect(gate.releases).toBe(1);
  });

  it("uses the exact OpenClaw dispatcher for the configured owner session", async () => {
    const peers: string[] = [];
    const dispatchConfigs: unknown[] = [];
    const recordInboundSession = vi.fn(() => Promise.resolve());
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn(
      async (params: never) => {
        const dispatcher = params as {
          dispatcherOptions: {
            deliver: (payload: unknown) => Promise<void>;
          };
        };
        await dispatcher.dispatcherOptions.deliver({
          text: "exact SDK answer",
        });
        return {} as never;
      },
    );
    const runtime = {
      channel: {
        routing: {
          resolveAgentRoute: ({
            cfg,
            peer,
          }: {
            cfg: unknown;
            peer: { id: string };
          }) => {
            dispatchConfigs.push(cfg);
            peers.push(peer.id);
            return {
              agentId: "main",
              sessionKey: `agent:main:nostr:direct:${peer.id}`,
              accountId: "default",
            };
          },
        },
        session: {
          resolveStorePath: () => "/tmp/armada-slice4-sessions.json",
          readSessionUpdatedAt: () => undefined,
          recordInboundSession,
        },
        reply: {
          resolveEnvelopeFormatOptions: () => ({}),
          formatAgentEnvelope: ({ body }: { body: string }) => body,
          finalizeInboundContext: (context: unknown) => context,
          dispatchReplyWithBufferedBlockDispatcher,
        },
      },
    } as never;
    const cfg = {
      messages: {
        visibleReplies: "message_tool",
        groupChat: { visibleReplies: "message_tool" },
      },
    } as const;
    const processor = createInboundProcessor({
      cfg,
      runtime,
      accountId: "default",
      config: {
        dmPolicy: "allowlist",
        allowFrom: [SENDER_PUBLIC_KEY],
        maxMessageAgeSeconds: 3_600,
        maxFutureSkewSeconds: 300,
      },
      identity: { secretKey: BOT_SECRET_KEY, publicKey: BOT_PUBLIC_KEY },
      replayGate: replayGate(),
      resolveRecipientRelays: () =>
        Promise.resolve(["wss://recipient.example/"]),
      publishRecipient: () => Promise.resolve(),
      publishSelfCopy: () => Promise.resolve(),
      nowSeconds: () => FIXTURE_NOW,
    });
    await processor.handle(createArmadaFixture());

    expect(peers).toEqual([SENDER_PUBLIC_KEY]);
    expect(dispatchConfigs).toEqual([
      {
        messages: {
          visibleReplies: "automatic",
          groupChat: { visibleReplies: "message_tool" },
        },
      },
    ]);
    expect(cfg.messages.visibleReplies).toBe("message_tool");
    expect(recordInboundSession).toHaveBeenCalledOnce();
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledOnce();
  });

  it("blocks a different authenticated sender through the real ingress resolver", async () => {
    const dispatch = vi.fn();
    const publishRecipient = vi.fn();
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
      replayGate: replayGate(),
      resolveRecipientRelays: () => Promise.reject(new Error("not called")),
      publishRecipient,
      publishSelfCopy: vi.fn(),
      dispatch,
      nowSeconds: () => FIXTURE_NOW,
    });
    const nonOwnerWrap = createDirectMessage({
      senderSecretKey: OTHER_SECRET_KEY,
      recipientPublicKey: BOT_PUBLIC_KEY,
      content: "not the owner",
      now: FIXTURE_NOW,
    }).recipient.wrap;

    await expect(processor.handle(nonOwnerWrap)).resolves.toEqual({
      handled: false,
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(publishRecipient).not.toHaveBeenCalled();
  });

  it("keeps peer delivery successful when recovery-copy publication fails", async () => {
    const publishRecipient = vi.fn(() => Promise.resolve());
    const publishSelfCopy = vi.fn(() =>
      Promise.reject(new Error("sensitive relay failure")),
    );
    const dispatch = vi.fn(async (params: never) => {
      await (
        params as { deliver: (payload: unknown) => Promise<void> }
      ).deliver({ text: "answer" });
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
      replayGate: replayGate(),
      resolveRecipientRelays: () =>
        Promise.resolve(["wss://recipient.example/"]),
      publishRecipient,
      publishSelfCopy,
      resolveIngress: () => Promise.resolve(allowDecision()),
      dispatch,
      nowSeconds: () => FIXTURE_NOW,
    });

    await expect(processor.handle(createArmadaFixture())).resolves.toEqual({
      handled: true,
      messageIds: [expect.any(String)],
      warnings: ["Sender recovery copy delivery failed."],
    });
    expect(publishRecipient).toHaveBeenCalledOnce();
    expect(publishSelfCopy).toHaveBeenCalledOnce();
  });

  it("does not publish a recovery copy when recipient delivery fails", async () => {
    const publishSelfCopy = vi.fn();
    const dispatch = vi.fn(async (params: never) => {
      await (
        params as { deliver: (payload: unknown) => Promise<void> }
      ).deliver({ text: "answer" });
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
      replayGate: replayGate(),
      resolveRecipientRelays: () =>
        Promise.resolve(["wss://recipient.example/"]),
      publishRecipient: () => Promise.reject(new Error("relay details")),
      publishSelfCopy,
      resolveIngress: () => Promise.resolve(allowDecision()),
      dispatch,
      nowSeconds: () => FIXTURE_NOW,
    });

    await expect(processor.handle(createArmadaFixture())).rejects.toThrow(
      "Direct message delivery failed.",
    );
    expect(publishSelfCopy).not.toHaveBeenCalled();
  });

  it("ignores sender recovery copies before replay claiming or dispatch", async () => {
    const gate = replayGate();
    const dispatch = vi.fn();
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
      replayGate: gate,
      resolveRecipientRelays: vi.fn(),
      publishRecipient: vi.fn(),
      publishSelfCopy: vi.fn(),
      resolveIngress: vi.fn(),
      dispatch,
      nowSeconds: () => FIXTURE_NOW,
    });
    const selfCopy = createDirectMessage({
      senderSecretKey: BOT_SECRET_KEY,
      recipientPublicKey: SENDER_PUBLIC_KEY,
      content: "previous reply",
      replyToEventId: createArmadaFixture().id,
      now: FIXTURE_NOW,
    }).selfCopy.wrap;

    await expect(processor.handle(selfCopy)).resolves.toEqual({
      handled: false,
    });
    expect(gate.claims).toBe(0);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("dispatches differently rewrapped copies of one inner rumor only once", async () => {
    const first = createDirectMessage({
      senderSecretKey: SENDER_SECRET_KEY,
      recipientPublicKey: BOT_PUBLIC_KEY,
      content: "same logical owner message",
      now: FIXTURE_NOW,
    });
    const second = createDirectMessage({
      senderSecretKey: SENDER_SECRET_KEY,
      recipientPublicKey: BOT_PUBLIC_KEY,
      content: "same logical owner message",
      now: FIXTURE_NOW,
    });
    expect(first.logicalMessageId).toBe(second.logicalMessageId);
    expect(first.recipient.wrap.id).not.toBe(second.recipient.wrap.id);
    const dispatch = vi.fn(() => Promise.resolve({} as never));
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
        dedupe: createClaimableDedupe({
          ttlMs: 3_600_000,
          memoryMaxSize: 32,
        }),
      }),
      resolveRecipientRelays: vi.fn(),
      publishRecipient: vi.fn(),
      publishSelfCopy: vi.fn(),
      resolveIngress: () => Promise.resolve(allowDecision()),
      dispatch,
      nowSeconds: () => FIXTURE_NOW,
    });

    await Promise.all([
      processor.handle(first.recipient.wrap),
      processor.handle(second.recipient.wrap),
    ]);
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("rate-limits authenticated owner bursts and refills deterministically", async () => {
    let nowMilliseconds = FIXTURE_NOW * 1_000;
    const dispatch = vi.fn(() => Promise.resolve({} as never));
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
      replayGate: replayGate(),
      resolveRecipientRelays: vi.fn(),
      publishRecipient: vi.fn(),
      publishSelfCopy: vi.fn(),
      resolveIngress: () => Promise.resolve(allowDecision()),
      dispatch,
      nowSeconds: () => FIXTURE_NOW,
      nowMilliseconds: () => nowMilliseconds,
    });
    const wrap = (index: number) =>
      createDirectMessage({
        senderSecretKey: SENDER_SECRET_KEY,
        recipientPublicKey: BOT_PUBLIC_KEY,
        content: `owner message ${String(index)}`,
        now: FIXTURE_NOW,
      }).recipient.wrap;

    for (let index = 0; index < 5; index += 1) {
      await expect(processor.handle(wrap(index))).resolves.toMatchObject({
        handled: true,
      });
    }
    await expect(processor.handle(wrap(5))).resolves.toEqual({
      handled: false,
      rateLimited: true,
    });
    nowMilliseconds += 6_000;
    await expect(processor.handle(wrap(6))).resolves.toMatchObject({
      handled: true,
    });
    expect(dispatch).toHaveBeenCalledTimes(6);
  });

  it("suppresses a model response delivered after account cancellation", async () => {
    const abort = new AbortController();
    let finishModel: (() => void) | undefined;
    const publishRecipient = vi.fn();
    const gate = replayGate();
    const dispatch = vi.fn(async (params: never) => {
      await new Promise<void>((resolve) => {
        finishModel = resolve;
      });
      await (
        params as { deliver: (payload: unknown) => Promise<void> }
      ).deliver({ text: "late answer" });
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
      replayGate: gate,
      resolveRecipientRelays: () =>
        Promise.resolve(["wss://recipient.example/"]),
      publishRecipient,
      publishSelfCopy: vi.fn(),
      resolveIngress: () => Promise.resolve(allowDecision()),
      dispatch,
      nowSeconds: () => FIXTURE_NOW,
    });

    const handling = processor.handle(createArmadaFixture(), abort.signal);
    await vi.waitFor(() => expect(finishModel).toBeTypeOf("function"));
    abort.abort();
    finishModel?.();

    await expect(handling).resolves.toEqual({ handled: false });
    expect(publishRecipient).not.toHaveBeenCalled();
    expect(gate.releases).toBe(1);
  });
});

function expectOuterPublicKey(secretKey: Uint8Array): string {
  // Imported lazily would obscure the assertion; this is scalar(3)'s pubkey.
  void secretKey;
  return "f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9";
}
