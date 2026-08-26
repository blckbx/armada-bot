import { randomBytes, randomInt } from "node:crypto";
import { nip44 } from "nostr-tools";
import {
  finalizeEvent,
  generateSecretKey,
  getEventHash,
  getPublicKey,
  verifyEvent,
  type EventTemplate,
  type NostrEvent,
  type UnsignedEvent,
} from "nostr-tools/pure";
import { SECURITY_LIMITS, type SecurityLimits } from "./security-limits.js";

const DIRECT_MESSAGE_KIND = 14;
const SEAL_KIND = 13;
const GIFT_WRAP_KIND = 1059;
const ARMADA_TYPING_KIND = 23_311;
const EPHEMERAL_GIFT_WRAP_KIND = 21_059;
const DEFAULT_MAX_MESSAGE_AGE_SECONDS = 7 * 24 * 60 * 60;
const DEFAULT_MAX_FUTURE_SKEW_SECONDS = 300;
const HEX_32 = /^[0-9a-f]{64}$/u;
const HEX_64 = /^[0-9a-f]{128}$/u;
const SIGNED_EVENT_KEYS = [
  "kind",
  "tags",
  "content",
  "created_at",
  "pubkey",
  "id",
  "sig",
] as const;
const RUMOR_KEYS = [
  "kind",
  "tags",
  "content",
  "created_at",
  "pubkey",
  "id",
] as const;
const UTF8 = new TextEncoder();
const CHARACTER_SEGMENTER = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

export class Nip17ProtocolError extends Error {
  constructor() {
    super("Invalid NIP-17 direct message.");
    this.name = "Nip17ProtocolError";
  }
}

export interface DirectMessageRumor extends UnsignedEvent {
  readonly kind: 14;
  readonly id: string;
}

export interface ArmadaTypingRumor extends UnsignedEvent {
  readonly kind: 23_311;
  readonly id: string;
}

export interface AuthenticatedDirectMessage {
  readonly direction: "incoming" | "self-copy";
  readonly rumorId: string;
  readonly senderPublicKey: string;
  readonly recipientPublicKey: string;
  readonly content: string;
  readonly createdAt: number;
  readonly replyToEventId: string | undefined;
  readonly rumor: DirectMessageRumor;
}

export interface UnwrapDirectMessageInput {
  readonly wrap: unknown;
  readonly recipientSecretKey: Uint8Array;
  readonly recipientPublicKey: string;
  readonly now?: number;
  readonly maxMessageAgeSeconds?: number;
  readonly maxFutureSkewSeconds?: number;
  readonly limits?: Partial<CryptoSecurityLimits>;
}

export interface ValidateGiftWrapCarrierInput {
  readonly wrap: unknown;
  readonly recipientPublicKey: string;
  readonly now?: number;
  readonly maxMessageAgeSeconds?: number;
  readonly maxFutureSkewSeconds?: number;
  readonly limits?: Partial<CryptoSecurityLimits>;
}

export interface Nip17EntropySource {
  generateSecretKey(): Uint8Array;
  generateNonce(): Uint8Array;
  randomTimestampOffset(maximumInclusive: number): number;
}

export interface CreateDirectMessageInput {
  readonly senderSecretKey: Uint8Array;
  readonly recipientPublicKey: string;
  readonly content: string;
  readonly replyToEventId?: string;
  readonly now?: number;
  /** Test-only deterministic entropy hook. Production callers must omit it. */
  readonly entropy?: Nip17EntropySource;
  readonly limits?: Partial<CryptoSecurityLimits>;
}

export interface CreateTypingIndicatorInput {
  readonly senderSecretKey: Uint8Array;
  readonly recipientPublicKey: string;
  readonly now?: number;
  /** Test-only deterministic entropy hook. Production callers must omit it. */
  readonly entropy?: Nip17EntropySource;
  readonly limits?: Partial<CryptoSecurityLimits>;
}

export interface GiftWrappedCopy {
  readonly seal: NostrEvent;
  readonly wrap: NostrEvent;
}

export interface CreatedDirectMessage {
  readonly logicalMessageId: string;
  readonly rumor: DirectMessageRumor;
  readonly recipient: GiftWrappedCopy;
  readonly selfCopy: GiftWrappedCopy;
}

export interface CreatedTypingIndicator extends GiftWrappedCopy {
  readonly rumor: ArmadaTypingRumor;
}

export type CryptoSecurityLimits = Pick<
  SecurityLimits,
  | "outerEventBytes"
  | "ciphertextBytes"
  | "tags"
  | "tagElements"
  | "tagElementBytes"
  | "outgoingTextCharacters"
  | "nip44PlaintextBytes"
  | "nip59TimestampWindowSeconds"
>;

const DEFAULT_ENTROPY: Nip17EntropySource = {
  generateSecretKey,
  generateNonce: () => Uint8Array.from(randomBytes(32)),
  randomTimestampOffset: (maximumInclusive) =>
    randomInt(0, maximumInclusive + 1),
};

export function unwrapDirectMessage(
  input: UnwrapDirectMessageInput,
): AuthenticatedDirectMessage {
  try {
    return unwrapDirectMessageStrict(input);
  } catch {
    throw new Nip17ProtocolError();
  }
}

export function validateGiftWrapCarrier(
  input: ValidateGiftWrapCarrierInput,
): NostrEvent {
  try {
    const limits = resolveLimits(input.limits);
    return validateGiftWrapCarrierStrict(
      input.wrap,
      requirePublicKey(input.recipientPublicKey),
      resolveTimestamp(input.now),
      resolveBound(input.maxMessageAgeSeconds, DEFAULT_MAX_MESSAGE_AGE_SECONDS),
      resolveBound(input.maxFutureSkewSeconds, DEFAULT_MAX_FUTURE_SKEW_SECONDS),
      limits,
    );
  } catch {
    throw new Nip17ProtocolError();
  }
}

export function createDirectMessage(
  input: CreateDirectMessageInput,
): CreatedDirectMessage {
  try {
    return createDirectMessageStrict(input);
  } catch {
    throw new Nip17ProtocolError();
  }
}

export function createTypingIndicator(
  input: CreateTypingIndicatorInput,
): CreatedTypingIndicator {
  try {
    return createTypingIndicatorStrict(input);
  } catch {
    throw new Nip17ProtocolError();
  }
}

function unwrapDirectMessageStrict(
  input: UnwrapDirectMessageInput,
): AuthenticatedDirectMessage {
  const limits = resolveLimits(input.limits);
  const now = resolveTimestamp(input.now);
  const maxMessageAgeSeconds = resolveBound(
    input.maxMessageAgeSeconds,
    DEFAULT_MAX_MESSAGE_AGE_SECONDS,
  );
  const maxFutureSkewSeconds = resolveBound(
    input.maxFutureSkewSeconds,
    DEFAULT_MAX_FUTURE_SKEW_SECONDS,
  );
  const recipientPublicKey = requirePublicKey(input.recipientPublicKey);
  const derivedRecipientPublicKey = getPublicKey(
    requireSecretKey(input.recipientSecretKey),
  );
  if (derivedRecipientPublicKey !== recipientPublicKey) fail();

  const wrap = validateGiftWrapCarrierStrict(
    input.wrap,
    recipientPublicKey,
    now,
    maxMessageAgeSeconds,
    maxFutureSkewSeconds,
    limits,
  );

  const sealPlaintext = decryptLayer(
    wrap.content,
    input.recipientSecretKey,
    wrap.pubkey,
    limits,
  );
  const seal = parseSignedEvent(parseJson(sealPlaintext), limits);
  if (
    seal.kind !== SEAL_KIND ||
    seal.tags.length !== 0 ||
    !isCarrierTimestampValid(
      seal.created_at,
      now,
      maxMessageAgeSeconds,
      maxFutureSkewSeconds,
      limits.nip59TimestampWindowSeconds,
    ) ||
    !verifySignedEvent(seal)
  ) {
    fail();
  }

  const rumorPlaintext = decryptLayer(
    seal.content,
    input.recipientSecretKey,
    seal.pubkey,
    limits,
  );
  const rumor = parseRumor(parseJson(rumorPlaintext), limits);
  const rumorRecipient = getSingleRecipient(rumor.tags);
  const direction =
    rumor.pubkey === recipientPublicKey ? "self-copy" : "incoming";
  if (
    rumor.pubkey !== seal.pubkey ||
    rumorRecipient === null ||
    (direction === "incoming" && rumorRecipient !== recipientPublicKey) ||
    (direction === "self-copy" && rumorRecipient === recipientPublicKey) ||
    !hasOnlySupportedRumorTags(rumor.tags) ||
    rumor.id !== getEventHash(rumor) ||
    rumor.created_at < now - maxMessageAgeSeconds ||
    rumor.created_at > now + maxFutureSkewSeconds
  ) {
    fail();
  }

  const replyToEventId = rumor.tags.find((tag) => tag[0] === "e")?.[1];
  return {
    direction,
    rumorId: rumor.id,
    senderPublicKey: rumor.pubkey,
    recipientPublicKey: rumorRecipient,
    content: rumor.content,
    createdAt: rumor.created_at,
    replyToEventId,
    rumor: cloneRumor(rumor),
  };
}

function validateGiftWrapCarrierStrict(
  value: unknown,
  recipientPublicKey: string,
  now: number,
  maxMessageAgeSeconds: number,
  maxFutureSkewSeconds: number,
  limits: CryptoSecurityLimits,
): NostrEvent {
  requireSerializedSize(value, limits.outerEventBytes);
  const wrap = parseSignedEvent(value, limits);
  if (
    wrap.kind !== GIFT_WRAP_KIND ||
    !hasOneRecipient(wrap.tags, recipientPublicKey) ||
    !hasOnlyHarmlessOuterTags(wrap.tags) ||
    !isCarrierTimestampValid(
      wrap.created_at,
      now,
      maxMessageAgeSeconds,
      maxFutureSkewSeconds,
      limits.nip59TimestampWindowSeconds,
    ) ||
    !verifySignedEvent(wrap)
  ) {
    fail();
  }
  return wrap;
}

function createDirectMessageStrict(
  input: CreateDirectMessageInput,
): CreatedDirectMessage {
  const limits = resolveLimits(input.limits);
  const now = resolveTimestamp(input.now);
  const senderSecretKey = requireSecretKey(input.senderSecretKey);
  const senderPublicKey = getPublicKey(senderSecretKey);
  const recipientPublicKey = requirePublicKey(input.recipientPublicKey);
  if (typeof input.content === "string") {
    requireUtf8Size(input.content, limits.nip44PlaintextBytes);
  }
  if (
    recipientPublicKey === senderPublicKey ||
    typeof input.content !== "string" ||
    countCharacters(input.content) > limits.outgoingTextCharacters ||
    (input.replyToEventId !== undefined && !HEX_32.test(input.replyToEventId))
  ) {
    fail();
  }

  const tags: string[][] = [["p", recipientPublicKey]];
  if (input.replyToEventId !== undefined)
    tags.push(["e", input.replyToEventId]);
  requireTags(tags, limits);

  const unsigned: UnsignedEvent = {
    kind: DIRECT_MESSAGE_KIND,
    content: input.content,
    tags,
    created_at: now,
    pubkey: senderPublicKey,
  };
  const rumor: DirectMessageRumor = {
    ...unsigned,
    kind: 14,
    id: getEventHash(unsigned),
  };
  const rumorPlaintext = JSON.stringify(rumor);
  requireUtf8Size(rumorPlaintext, limits.nip44PlaintextBytes);

  const entropy = input.entropy ?? DEFAULT_ENTROPY;
  const recipient = createGiftWrappedCopy({
    rumorPlaintext,
    senderSecretKey,
    recipientPublicKey,
    now,
    entropy,
    limits,
  });
  const selfCopy = createGiftWrappedCopy({
    rumorPlaintext,
    senderSecretKey,
    recipientPublicKey: senderPublicKey,
    now,
    entropy,
    limits,
  });
  if (
    recipient.wrap.pubkey === senderPublicKey ||
    selfCopy.wrap.pubkey === senderPublicKey ||
    recipient.wrap.pubkey === selfCopy.wrap.pubkey
  ) {
    fail();
  }

  return {
    logicalMessageId: rumor.id,
    rumor: cloneRumor(rumor),
    recipient,
    selfCopy,
  };
}

function createTypingIndicatorStrict(
  input: CreateTypingIndicatorInput,
): CreatedTypingIndicator {
  const limits = resolveLimits(input.limits);
  const now = resolveTimestamp(input.now);
  const senderSecretKey = requireSecretKey(input.senderSecretKey);
  const senderPublicKey = getPublicKey(senderSecretKey);
  const recipientPublicKey = requirePublicKey(input.recipientPublicKey);
  if (recipientPublicKey === senderPublicKey) fail();

  const tags = requireTags([["p", recipientPublicKey]], limits);
  const unsigned: UnsignedEvent = {
    kind: ARMADA_TYPING_KIND,
    content: "",
    tags,
    created_at: now,
    pubkey: senderPublicKey,
  };
  const rumor: ArmadaTypingRumor = {
    ...unsigned,
    kind: 23_311,
    id: getEventHash(unsigned),
  };
  const rumorPlaintext = JSON.stringify(rumor);
  requireUtf8Size(rumorPlaintext, limits.nip44PlaintextBytes);

  const entropy = input.entropy ?? DEFAULT_ENTROPY;
  const sealContent = encryptLayer(
    rumorPlaintext,
    senderSecretKey,
    recipientPublicKey,
    entropy,
    limits,
  );
  const seal = finalizeEvent(
    carrierTemplate(
      SEAL_KIND,
      sealContent,
      [],
      now,
      entropy,
      limits.nip59TimestampWindowSeconds,
    ),
    senderSecretKey,
  );
  const plainSeal = toPlainSignedEvent(seal);
  const sealPlaintext = JSON.stringify(plainSeal);
  requireUtf8Size(sealPlaintext, limits.nip44PlaintextBytes);

  const wrapperSecretKey = requireSecretKey(entropy.generateSecretKey());
  const wrapContent = encryptLayer(
    sealPlaintext,
    wrapperSecretKey,
    recipientPublicKey,
    entropy,
    limits,
  );
  const wrap = toPlainSignedEvent(
    finalizeEvent(
      {
        kind: EPHEMERAL_GIFT_WRAP_KIND,
        content: wrapContent,
        tags: [["p", recipientPublicKey]],
        created_at: now,
      },
      wrapperSecretKey,
    ),
  );
  requireSerializedSize(wrap, limits.outerEventBytes);
  requireUtf8Size(wrap.content, limits.ciphertextBytes);
  if (wrap.pubkey === senderPublicKey) fail();

  return {
    rumor: { ...rumor, tags: rumor.tags.map((tag) => [...tag]) },
    seal: plainSeal,
    wrap,
  };
}

function createGiftWrappedCopy(input: {
  rumorPlaintext: string;
  senderSecretKey: Uint8Array;
  recipientPublicKey: string;
  now: number;
  entropy: Nip17EntropySource;
  limits: CryptoSecurityLimits;
}): GiftWrappedCopy {
  const sealContent = encryptLayer(
    input.rumorPlaintext,
    input.senderSecretKey,
    input.recipientPublicKey,
    input.entropy,
    input.limits,
  );
  const seal = finalizeEvent(
    carrierTemplate(
      SEAL_KIND,
      sealContent,
      [],
      input.now,
      input.entropy,
      input.limits.nip59TimestampWindowSeconds,
    ),
    input.senderSecretKey,
  );
  const sealPlaintext = JSON.stringify(toPlainSignedEvent(seal));
  requireUtf8Size(sealPlaintext, input.limits.nip44PlaintextBytes);

  const wrapperSecretKey = requireSecretKey(input.entropy.generateSecretKey());
  const wrapContent = encryptLayer(
    sealPlaintext,
    wrapperSecretKey,
    input.recipientPublicKey,
    input.entropy,
    input.limits,
  );
  const wrap = finalizeEvent(
    carrierTemplate(
      GIFT_WRAP_KIND,
      wrapContent,
      [["p", input.recipientPublicKey]],
      input.now,
      input.entropy,
      input.limits.nip59TimestampWindowSeconds,
    ),
    wrapperSecretKey,
  );
  requireSerializedSize(toPlainSignedEvent(wrap), input.limits.outerEventBytes);
  requireUtf8Size(wrap.content, input.limits.ciphertextBytes);

  return { seal: toPlainSignedEvent(seal), wrap: toPlainSignedEvent(wrap) };
}

function carrierTemplate(
  kind: number,
  content: string,
  tags: string[][],
  now: number,
  entropy: Nip17EntropySource,
  maximumOffset: number,
): EventTemplate {
  const offset = entropy.randomTimestampOffset(maximumOffset);
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > maximumOffset ||
    offset > now
  )
    fail();
  return { kind, content, tags, created_at: now - offset };
}

function encryptLayer(
  plaintext: string,
  senderSecretKey: Uint8Array,
  recipientPublicKey: string,
  entropy: Nip17EntropySource,
  limits: CryptoSecurityLimits,
): string {
  requireUtf8Size(plaintext, limits.nip44PlaintextBytes);
  const nonce = entropy.generateNonce();
  if (!(nonce instanceof Uint8Array) || nonce.length !== 32) fail();
  const conversationKey = nip44.v2.utils.getConversationKey(
    senderSecretKey,
    recipientPublicKey,
  );
  const ciphertext = nip44.v2.encrypt(plaintext, conversationKey, nonce);
  requireUtf8Size(ciphertext, limits.ciphertextBytes);
  return ciphertext;
}

function decryptLayer(
  ciphertext: string,
  recipientSecretKey: Uint8Array,
  senderPublicKey: string,
  limits: CryptoSecurityLimits,
): string {
  requireUtf8Size(ciphertext, limits.ciphertextBytes);
  const conversationKey = nip44.v2.utils.getConversationKey(
    recipientSecretKey,
    senderPublicKey,
  );
  const plaintext = nip44.v2.decrypt(ciphertext, conversationKey);
  requireUtf8Size(plaintext, limits.nip44PlaintextBytes);
  return plaintext;
}

function parseSignedEvent(
  value: unknown,
  limits: CryptoSecurityLimits,
): NostrEvent {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, SIGNED_EVENT_KEYS) ||
    !Number.isSafeInteger(value["kind"]) ||
    !Number.isSafeInteger(value["created_at"]) ||
    (value["created_at"] as number) < 0 ||
    typeof value["content"] !== "string" ||
    typeof value["pubkey"] !== "string" ||
    !HEX_32.test(value["pubkey"]) ||
    typeof value["id"] !== "string" ||
    !HEX_32.test(value["id"]) ||
    typeof value["sig"] !== "string" ||
    !HEX_64.test(value["sig"])
  ) {
    fail();
  }
  const tags = requireTags(value["tags"], limits);
  requireUtf8Size(value["content"], limits.ciphertextBytes);
  return {
    kind: value["kind"] as number,
    tags,
    content: value["content"],
    created_at: value["created_at"] as number,
    pubkey: value["pubkey"],
    id: value["id"],
    sig: value["sig"],
  };
}

function parseRumor(
  value: unknown,
  limits: CryptoSecurityLimits,
): DirectMessageRumor {
  if (
    !isRecord(value) ||
    Object.hasOwn(value, "sig") ||
    !hasOnlyKeys(value, RUMOR_KEYS) ||
    value["kind"] !== DIRECT_MESSAGE_KIND ||
    !Number.isSafeInteger(value["created_at"]) ||
    (value["created_at"] as number) < 0 ||
    typeof value["content"] !== "string" ||
    typeof value["pubkey"] !== "string" ||
    !HEX_32.test(value["pubkey"]) ||
    typeof value["id"] !== "string" ||
    !HEX_32.test(value["id"])
  ) {
    fail();
  }
  const tags = requireTags(value["tags"], limits);
  return {
    kind: 14,
    tags,
    content: value["content"],
    created_at: value["created_at"] as number,
    pubkey: value["pubkey"],
    id: value["id"],
  };
}

function verifySignedEvent(event: NostrEvent): boolean {
  return verifyEvent(toPlainSignedEvent(event));
}

function toPlainSignedEvent(event: NostrEvent): NostrEvent {
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

function cloneRumor(rumor: DirectMessageRumor): DirectMessageRumor {
  return { ...rumor, tags: rumor.tags.map((tag) => [...tag]) };
}

function requireTags(value: unknown, limits: CryptoSecurityLimits): string[][] {
  if (!Array.isArray(value) || value.length > limits.tags) fail();
  const tags: string[][] = [];
  for (const candidate of value) {
    if (
      !Array.isArray(candidate) ||
      candidate.length === 0 ||
      candidate.length > limits.tagElements
    ) {
      fail();
    }
    const tag: string[] = [];
    for (const element of candidate) {
      if (typeof element !== "string") fail();
      requireUtf8Size(element, limits.tagElementBytes);
      tag.push(element);
    }
    tags.push(tag);
  }
  return tags;
}

function hasOneRecipient(
  tags: string[][],
  recipientPublicKey: string,
): boolean {
  const recipients = tags.filter((tag) => tag[0] === "p");
  const recipient = recipients[0];
  return (
    recipients.length === 1 &&
    recipient?.length === 2 &&
    recipient[1] === recipientPublicKey
  );
}

function getSingleRecipient(tags: string[][]): string | null {
  const recipients = tags.filter((tag) => tag[0] === "p");
  const recipient = recipients[0];
  if (
    recipients.length !== 1 ||
    recipient?.length !== 2 ||
    recipient[1] === undefined ||
    !HEX_32.test(recipient[1])
  ) {
    return null;
  }
  return recipient[1];
}

function hasOnlyHarmlessOuterTags(tags: string[][]): boolean {
  let kindHints = 0;
  for (const tag of tags) {
    if (tag[0] === "p") continue;
    if (tag[0] === "k" && tag.length === 2 && tag[1] === "14") {
      kindHints += 1;
      continue;
    }
    return false;
  }
  return kindHints <= 1;
}

function hasOnlySupportedRumorTags(tags: string[][]): boolean {
  let replies = 0;
  for (const tag of tags) {
    if (tag[0] === "p") continue;
    if (
      tag[0] === "e" &&
      tag.length === 2 &&
      tag[1] !== undefined &&
      HEX_32.test(tag[1])
    ) {
      replies += 1;
      continue;
    }
    return false;
  }
  return replies <= 1;
}

function isCarrierTimestampValid(
  timestamp: number,
  now: number,
  maximumMessageAge: number,
  maximumFutureSkew: number,
  timestampWindow: number,
): boolean {
  return (
    timestamp >= now - maximumMessageAge - timestampWindow &&
    timestamp <= now + maximumFutureSkew
  );
}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}

function requireSecretKey(value: Uint8Array): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== 32) fail();
  const copy = Uint8Array.from(value);
  getPublicKey(copy);
  return copy;
}

function requirePublicKey(value: string): string {
  if (typeof value !== "string" || !HEX_32.test(value)) fail();
  return value;
}

function resolveTimestamp(value: number | undefined): number {
  const timestamp = value ?? Math.floor(Date.now() / 1_000);
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) fail();
  return timestamp;
}

function resolveBound(value: number | undefined, defaultValue: number): number {
  const resolved = value ?? defaultValue;
  if (!Number.isSafeInteger(resolved) || resolved < 0) fail();
  return resolved;
}

function resolveLimits(
  overrides: Partial<CryptoSecurityLimits> | undefined,
): CryptoSecurityLimits {
  const resolved = { ...SECURITY_LIMITS, ...overrides };
  for (const key of Object.keys(
    SECURITY_LIMITS,
  ) as (keyof CryptoSecurityLimits)[]) {
    const value = resolved[key];
    if (
      !Number.isSafeInteger(value) ||
      value < 1 ||
      value > SECURITY_LIMITS[key]
    )
      fail();
  }
  return resolved;
}

function requireSerializedSize(value: unknown, maximum: number): void {
  requireUtf8Size(JSON.stringify(value), maximum);
}

function requireUtf8Size(value: string, maximum: number): void {
  if (UTF8.encode(value).byteLength > maximum) fail();
}

function countCharacters(value: string): number {
  return Array.from(CHARACTER_SEGMENTER.segment(value)).length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}

function fail(): never {
  throw new Error("invalid");
}
