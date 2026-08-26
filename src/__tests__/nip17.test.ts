import { nip19 } from "nostr-tools";
import { getEventHash, verifyEvent, type NostrEvent } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";
import {
  createDirectMessage,
  createTypingIndicator,
  Nip17ProtocolError,
  unwrapDirectMessage,
} from "../nip17.js";
import { SECURITY_LIMITS } from "../security-limits.js";
import {
  BOT_PUBLIC_KEY,
  BOT_SECRET_KEY,
  createArmadaFixture,
  createRumor,
  deterministicEntropy,
  FIXTURE_NOW,
  independentlyOpenWrap,
  OTHER_PUBLIC_KEY,
  resignWrap,
  SENDER_PUBLIC_KEY,
  SENDER_SECRET_KEY,
} from "./nip17-fixtures.js";

const BOUNDS = {
  now: FIXTURE_NOW,
  maxMessageAgeSeconds: 86_400,
  maxFutureSkewSeconds: 300,
} as const;

function unwrap(wrap: unknown) {
  return unwrapDirectMessage({
    wrap,
    recipientSecretKey: BOT_SECRET_KEY,
    recipientPublicKey: BOT_PUBLIC_KEY,
    ...BOUNDS,
  });
}

function expectProtocolError(action: () => unknown): void {
  expect(action).toThrow(Nip17ProtocolError);
  try {
    action();
  } catch (error) {
    expect(String(error)).toBe(
      "Nip17ProtocolError: Invalid NIP-17 direct message.",
    );
  }
}

describe("NIP-17 inbound cryptographic core", () => {
  it("authenticates an Armada-compatible kind-14 gift wrap", () => {
    const wrap = createArmadaFixture();
    const opened = unwrap(wrap);

    expect(opened).toEqual({
      direction: "incoming",
      kind: 14,
      rumorId: createRumor().id,
      senderPublicKey: SENDER_PUBLIC_KEY,
      recipientPublicKey: BOT_PUBLIC_KEY,
      content: "armada fixture plaintext",
      createdAt: FIXTURE_NOW - 60,
      replyToEventId: undefined,
      rumor: createRumor(),
    });
    expect(opened.senderPublicKey).not.toBe(wrap.pubkey);
  });

  it("authenticates a one-to-one kind-15 encrypted file rumor", () => {
    const unsigned = {
      kind: 15,
      content: "https://blossom.example/file.bin",
      tags: [
        ["p", BOT_PUBLIC_KEY],
        ["file-type", "image/png"],
        ["encryption-algorithm", "aes-gcm"],
        ["decryption-key", "11".repeat(32)],
        ["decryption-nonce", "22".repeat(16)],
        ["x", "33".repeat(32)],
      ],
      created_at: FIXTURE_NOW - 60,
      pubkey: SENDER_PUBLIC_KEY,
    };
    const rumor = { ...unsigned, id: getEventHash(unsigned) };

    const opened = unwrap(createArmadaFixture({ rumorTransform: () => rumor }));

    expect(opened.rumor).toEqual(rumor);
    expect(opened.kind).toBe(15);
    expect(opened.content).toBe("https://blossom.example/file.bin");
    expect(opened.senderPublicKey).toBe(SENDER_PUBLIC_KEY);
  });

  it("authenticates Armada kind-14 encrypted imeta attachment tags", () => {
    const unsigned = {
      kind: 14,
      content: "please inspect\nhttps://blossom.example/file.bin",
      tags: [
        ["p", BOT_PUBLIC_KEY],
        [
          "imeta",
          "url https://blossom.example/file.bin",
          "m audio/ogg",
          `x ${"33".repeat(32)}`,
          "encryption-algorithm aes-gcm",
          `decryption-key ${"11".repeat(32)}`,
          `decryption-nonce ${"22".repeat(16)}`,
        ],
      ],
      created_at: FIXTURE_NOW - 60,
      pubkey: SENDER_PUBLIC_KEY,
    };
    const rumor = { ...unsigned, id: getEventHash(unsigned) };

    const opened = unwrap(createArmadaFixture({ rumorTransform: () => rumor }));

    expect(opened.rumor).toEqual(rumor);
    expect(opened.kind).toBe(14);
  });

  it("classifies a valid bot-addressed sender recovery copy", () => {
    const created = createDirectMessage({
      senderSecretKey: BOT_SECRET_KEY,
      recipientPublicKey: SENDER_PUBLIC_KEY,
      content: "conversation-bound reply",
      replyToEventId: createRumor().id,
      now: FIXTURE_NOW,
    });

    expect(unwrap(created.selfCopy.wrap)).toMatchObject({
      direction: "self-copy",
      rumorId: created.logicalMessageId,
      senderPublicKey: BOT_PUBLIC_KEY,
      recipientPublicKey: SENDER_PUBLIC_KEY,
      content: "conversation-bound reply",
      replyToEventId: createRumor().id,
    });
  });

  it.each([
    [
      "wrong signed outer kind",
      (wrap: NostrEvent) => resignWrap(wrap, { kind: 1060 }),
    ],
    [
      "mutated outer id",
      (wrap: NostrEvent) => ({ ...wrap, id: "0".repeat(64) }),
    ],
    [
      "mutated outer signature",
      (wrap: NostrEvent) => ({ ...wrap, sig: "0".repeat(128) }),
    ],
    [
      "mutated outer author",
      (wrap: NostrEvent) => ({ ...wrap, pubkey: OTHER_PUBLIC_KEY }),
    ],
    [
      "wrong recipient",
      (wrap: NostrEvent) =>
        resignWrap(wrap, { tags: [["p", OTHER_PUBLIC_KEY]] }),
    ],
    [
      "multiple recipients",
      (wrap: NostrEvent) =>
        resignWrap(wrap, {
          tags: [
            ["p", BOT_PUBLIC_KEY],
            ["p", OTHER_PUBLIC_KEY],
          ],
        }),
    ],
    [
      "old outer timestamp",
      (wrap: NostrEvent) =>
        resignWrap(wrap, {
          created_at:
            FIXTURE_NOW -
            BOUNDS.maxMessageAgeSeconds -
            SECURITY_LIMITS.nip59TimestampWindowSeconds -
            1,
        }),
    ],
    [
      "future outer timestamp",
      (wrap: NostrEvent) =>
        resignWrap(wrap, {
          created_at: FIXTURE_NOW + BOUNDS.maxFutureSkewSeconds + 1,
        }),
    ],
    [
      "malformed outer ciphertext",
      (wrap: NostrEvent) => resignWrap(wrap, { content: "bad" }),
    ],
  ])("rejects %s", (_name, mutate) => {
    expectProtocolError(() => unwrap(mutate(createArmadaFixture())));
  });

  it.each([
    ["malformed seal JSON", { sealTransform: () => "{" }],
    ["wrong seal kind", { sealTemplate: { kind: 14 } }],
    ["seal tags", { sealTemplate: { tags: [["p", BOT_PUBLIC_KEY]] } }],
    [
      "old seal timestamp",
      {
        sealTemplate: {
          created_at:
            FIXTURE_NOW -
            BOUNDS.maxMessageAgeSeconds -
            SECURITY_LIMITS.nip59TimestampWindowSeconds -
            1,
        },
      },
    ],
    [
      "future seal timestamp",
      {
        sealTemplate: {
          created_at: FIXTURE_NOW + BOUNDS.maxFutureSkewSeconds + 1,
        },
      },
    ],
    [
      "mutated seal id",
      {
        sealTransform: (seal: NostrEvent) => ({ ...seal, id: "0".repeat(64) }),
      },
    ],
    [
      "mutated seal signature",
      {
        sealTransform: (seal: NostrEvent) => ({
          ...seal,
          sig: "0".repeat(128),
        }),
      },
    ],
    [
      "mutated seal author",
      {
        sealTransform: (seal: NostrEvent) => ({
          ...seal,
          pubkey: OTHER_PUBLIC_KEY,
        }),
      },
    ],
    [
      "mutated seal ciphertext",
      {
        sealTransform: (seal: NostrEvent) => ({
          ...seal,
          content: `${seal.content.slice(0, 20)}${seal.content[20] === "A" ? "B" : "A"}${seal.content.slice(21)}`,
        }),
      },
    ],
    ["seal recipient mismatch", { sealRecipientPublicKey: OTHER_PUBLIC_KEY }],
  ])("rejects %s", (_name, options) => {
    expectProtocolError(() => unwrap(createArmadaFixture(options)));
  });

  it.each([
    ["malformed rumor JSON", { rumorPlaintext: "{" }],
    [
      "rumor signature field",
      {
        rumorTransform: (rumor: ReturnType<typeof createRumor>) => ({
          ...rumor,
          sig: "",
        }),
      },
    ],
    [
      "wrong rumor ID",
      {
        rumorTransform: (rumor: ReturnType<typeof createRumor>) => ({
          ...rumor,
          id: "0".repeat(64),
        }),
      },
    ],
    [
      "mutated rumor content",
      {
        rumorTransform: (rumor: ReturnType<typeof createRumor>) => ({
          ...rumor,
          content: `${rumor.content}!`,
        }),
      },
    ],
    [
      "wrong rumor recipient",
      {
        rumorTransform: (rumor: ReturnType<typeof createRumor>) => {
          const changed = { ...rumor, tags: [["p", OTHER_PUBLIC_KEY]] };
          return { ...changed, id: getEventHash(changed) };
        },
      },
    ],
    [
      "multiple rumor recipients",
      {
        rumorTransform: (rumor: ReturnType<typeof createRumor>) => {
          const changed = {
            ...rumor,
            tags: [
              ["p", BOT_PUBLIC_KEY],
              ["p", OTHER_PUBLIC_KEY],
            ],
          };
          return { ...changed, id: getEventHash(changed) };
        },
      },
    ],
    [
      "group subject",
      {
        rumorTransform: (rumor: ReturnType<typeof createRumor>) => {
          const changed = {
            ...rumor,
            tags: [...rumor.tags, ["subject", "group"]],
          };
          return { ...changed, id: getEventHash(changed) };
        },
      },
    ],
    [
      "unsupported rumor kind",
      {
        rumorTransform: (rumor: ReturnType<typeof createRumor>) => {
          const changed = { ...rumor, kind: 16 };
          return { ...changed, id: getEventHash(changed) };
        },
      },
    ],
    [
      "seal-author/rumor-author mismatch",
      {
        rumorTransform: (rumor: ReturnType<typeof createRumor>) => {
          const changed = { ...rumor, pubkey: OTHER_PUBLIC_KEY };
          return { ...changed, id: getEventHash(changed) };
        },
      },
    ],
    [
      "stale rumor",
      {
        rumorTransform: (rumor: ReturnType<typeof createRumor>) => {
          const changed = {
            ...rumor,
            created_at: FIXTURE_NOW - BOUNDS.maxMessageAgeSeconds - 1,
          };
          return { ...changed, id: getEventHash(changed) };
        },
      },
    ],
    [
      "future rumor",
      {
        rumorTransform: (rumor: ReturnType<typeof createRumor>) => {
          const changed = {
            ...rumor,
            created_at: FIXTURE_NOW + BOUNDS.maxFutureSkewSeconds + 1,
          };
          return { ...changed, id: getEventHash(changed) };
        },
      },
    ],
  ])("rejects %s", (_name, options) => {
    expectProtocolError(() => unwrap(createArmadaFixture(options)));
  });

  it("rejects malformed and oversized structures before cryptographic work", () => {
    const wrap = createArmadaFixture();
    const oversizedCiphertext = "x".repeat(SECURITY_LIMITS.ciphertextBytes + 1);
    expectProtocolError(() =>
      unwrap(resignWrap(wrap, { content: oversizedCiphertext })),
    );
    expectProtocolError(() =>
      unwrap(
        resignWrap(wrap, {
          tags: Array.from({ length: SECURITY_LIMITS.tags + 1 }, () => [
            "k",
            "14",
          ]),
        }),
      ),
    );
    expectProtocolError(() =>
      unwrap(
        resignWrap(wrap, {
          tags: [["k", "x".repeat(SECURITY_LIMITS.tagElementBytes + 1)]],
        }),
      ),
    );
    expectProtocolError(() =>
      unwrap(
        resignWrap(wrap, {
          tags: [
            ["p", BOT_PUBLIC_KEY],
            ["subject", "group"],
          ],
        }),
      ),
    );
  });

  it("honors only lower resource-limit overrides", () => {
    const wrap = createArmadaFixture();
    expectProtocolError(() =>
      unwrapDirectMessage({
        wrap,
        recipientSecretKey: BOT_SECRET_KEY,
        recipientPublicKey: BOT_PUBLIC_KEY,
        ...BOUNDS,
        limits: { ciphertextBytes: wrap.content.length - 1 },
      }),
    );
    expectProtocolError(() =>
      unwrapDirectMessage({
        wrap,
        recipientSecretKey: BOT_SECRET_KEY,
        recipientPublicKey: BOT_PUBLIC_KEY,
        ...BOUNDS,
        limits: { ciphertextBytes: SECURITY_LIMITS.ciphertextBytes + 1 },
      }),
    );
  });

  it("uses one sanitized error that cannot reveal protected values", () => {
    const wrap = createArmadaFixture();
    const protectedValues = [
      nip19.nsecEncode(BOT_SECRET_KEY),
      "armada fixture plaintext",
      wrap.content,
      JSON.stringify(wrap),
      `${SENDER_PUBLIC_KEY}:${BOT_PUBLIC_KEY}`,
    ];

    try {
      unwrap({ ...wrap, sig: "0".repeat(128) });
      throw new Error("expected fixture to fail");
    } catch (error) {
      const rendered = String(error);
      for (const value of protectedValues)
        expect(rendered).not.toContain(value);
    }
  });
});

describe("Armada ephemeral typing extension", () => {
  it("creates a current kind-23311 rumor in a kind-21059 ephemeral wrap", () => {
    const created = createTypingIndicator({
      senderSecretKey: BOT_SECRET_KEY,
      recipientPublicKey: SENDER_PUBLIC_KEY,
      now: FIXTURE_NOW,
      entropy: deterministicEntropy(),
    });
    const opened = independentlyOpenWrap(created.wrap, SENDER_SECRET_KEY);

    expect(created.wrap).toMatchObject({
      kind: 21_059,
      tags: [["p", SENDER_PUBLIC_KEY]],
      created_at: FIXTURE_NOW,
    });
    expect(created.wrap.pubkey).not.toBe(BOT_PUBLIC_KEY);
    expect(verifyEvent(created.wrap)).toBe(true);
    expect(created.seal.kind).toBe(13);
    expect(created.seal.tags).toEqual([]);
    expect(created.seal.pubkey).toBe(BOT_PUBLIC_KEY);
    expect(created.seal.created_at).toBeLessThanOrEqual(FIXTURE_NOW);
    expect(created.seal.created_at).toBeGreaterThanOrEqual(
      FIXTURE_NOW - SECURITY_LIMITS.nip59TimestampWindowSeconds,
    );
    expect(verifyEvent(created.seal)).toBe(true);
    expect(opened.rumor).toEqual(created.rumor);
    expect(opened.rumor).toMatchObject({
      kind: 23_311,
      content: "",
      tags: [["p", SENDER_PUBLIC_KEY]],
      created_at: FIXTURE_NOW,
      pubkey: BOT_PUBLIC_KEY,
    });
    expect(opened.rumor.id).toBe(getEventHash(opened.rumor));
    expect(
      [created.rumor, created.seal, created.wrap].some((event) =>
        event.tags.some((tag) => tag[0] === "expiration"),
      ),
    ).toBe(false);
  });

  it("rejects a typing indicator addressed to the sender", () => {
    expectProtocolError(() =>
      createTypingIndicator({
        senderSecretKey: BOT_SECRET_KEY,
        recipientPublicKey: BOT_PUBLIC_KEY,
        now: FIXTURE_NOW,
      }),
    );
  });
});

describe("NIP-17 outbound cryptographic core", () => {
  it("creates independently decryptable recipient and sender copies", () => {
    const result = createDirectMessage({
      senderSecretKey: BOT_SECRET_KEY,
      recipientPublicKey: SENDER_PUBLIC_KEY,
      content: "bot response",
      replyToEventId: createRumor().id,
      now: FIXTURE_NOW,
      entropy: deterministicEntropy(),
    });

    expect(result.logicalMessageId).toBe(result.rumor.id);
    expect(result.rumor.tags).toEqual([
      ["p", SENDER_PUBLIC_KEY],
      ["e", createRumor().id],
    ]);
    expect(result.recipient.wrap.tags).toEqual([["p", SENDER_PUBLIC_KEY]]);
    expect(result.selfCopy.wrap.tags).toEqual([["p", BOT_PUBLIC_KEY]]);

    const recipientOpened = independentlyOpenWrap(
      result.recipient.wrap,
      SENDER_SECRET_KEY,
    );
    const selfOpened = independentlyOpenWrap(
      result.selfCopy.wrap,
      BOT_SECRET_KEY,
    );
    expect(recipientOpened.rumor).toEqual(result.rumor);
    expect(selfOpened.rumor).toEqual(result.rumor);
    expect(recipientOpened.rumor.id).toBe(selfOpened.rumor.id);
    expect(verifyEvent(recipientOpened.seal)).toBe(true);
    expect(verifyEvent(result.recipient.wrap)).toBe(true);

    expect(result.recipient.seal.created_at).toBe(FIXTURE_NOW - 101);
    expect(result.recipient.wrap.created_at).toBe(FIXTURE_NOW - 202);
    expect(result.selfCopy.seal.created_at).toBe(FIXTURE_NOW - 303);
    expect(result.selfCopy.wrap.created_at).toBe(FIXTURE_NOW - 404);
  });

  it("never reuses wrapper keys or outer IDs for identical messages", () => {
    const input = {
      senderSecretKey: BOT_SECRET_KEY,
      recipientPublicKey: SENDER_PUBLIC_KEY,
      content: "same logical reply",
      replyToEventId: createRumor().id,
      now: FIXTURE_NOW,
    } as const;
    const first = createDirectMessage(input);
    const second = createDirectMessage(input);

    expect(first.rumor).toEqual(second.rumor);
    expect(first.recipient.seal.id).not.toBe(second.recipient.seal.id);
    expect(first.recipient.wrap.pubkey).not.toBe(second.recipient.wrap.pubkey);
    expect(first.recipient.wrap.id).not.toBe(second.recipient.wrap.id);
    expect(first.selfCopy.seal.id).not.toBe(second.selfCopy.seal.id);
    expect(first.selfCopy.wrap.pubkey).not.toBe(second.selfCopy.wrap.pubkey);
    expect(first.selfCopy.wrap.id).not.toBe(second.selfCopy.wrap.id);
  });

  it("rejects oversized text and plaintext envelopes", () => {
    const common = {
      senderSecretKey: BOT_SECRET_KEY,
      recipientPublicKey: SENDER_PUBLIC_KEY,
      now: FIXTURE_NOW,
    } as const;
    expectProtocolError(() =>
      createDirectMessage({
        ...common,
        content: "x".repeat(SECURITY_LIMITS.outgoingTextCharacters + 1),
      }),
    );
    expectProtocolError(() =>
      createDirectMessage({
        ...common,
        content: "😀".repeat(16_000),
      }),
    );
  });
});
