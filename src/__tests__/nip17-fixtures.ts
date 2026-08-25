import { nip44 } from "nostr-tools";
import {
  finalizeEvent,
  getEventHash,
  getPublicKey,
  type EventTemplate,
  type NostrEvent,
  type UnsignedEvent,
} from "nostr-tools/pure";

export const FIXTURE_NOW = 2_000_000_000;

export const BOT_SECRET_KEY = scalar(1);
export const SENDER_SECRET_KEY = scalar(2);
export const WRAPPER_SECRET_KEY = scalar(3);
export const OTHER_SECRET_KEY = scalar(4);

export const BOT_PUBLIC_KEY = getPublicKey(BOT_SECRET_KEY);
export const SENDER_PUBLIC_KEY = getPublicKey(SENDER_SECRET_KEY);
export const OTHER_PUBLIC_KEY = getPublicKey(OTHER_SECRET_KEY);

export interface FixtureRumor extends UnsignedEvent {
  id: string;
}

export interface ArmadaFixtureOptions {
  rumorPlaintext?: string;
  rumorTransform?: (rumor: FixtureRumor) => unknown;
  sealRecipientPublicKey?: string;
  sealTemplate?: Partial<EventTemplate>;
  sealTransform?: (seal: NostrEvent) => unknown;
  wrapTemplate?: Partial<EventTemplate>;
  wrapTransform?: (wrap: NostrEvent) => NostrEvent;
}

export function scalar(value: number): Uint8Array {
  const result = new Uint8Array(32);
  result[31] = value;
  return result;
}

export function createArmadaFixture(
  options: ArmadaFixtureOptions = {},
): NostrEvent {
  const rumor = createRumor();
  const rumorValue = options.rumorTransform?.(rumor) ?? rumor;
  const rumorPlaintext = options.rumorPlaintext ?? JSON.stringify(rumorValue);
  const sealRecipient = options.sealRecipientPublicKey ?? BOT_PUBLIC_KEY;
  const sealContent = nip44.v2.encrypt(
    rumorPlaintext,
    nip44.v2.utils.getConversationKey(SENDER_SECRET_KEY, sealRecipient),
    nonce(11),
  );
  const seal = finalizeEvent(
    {
      kind: 13,
      content: sealContent,
      tags: [],
      created_at: FIXTURE_NOW - 1_200,
      ...options.sealTemplate,
    },
    SENDER_SECRET_KEY,
  );
  const sealValue = options.sealTransform?.(seal) ?? seal;
  const wrapContent = nip44.v2.encrypt(
    JSON.stringify(sealValue),
    nip44.v2.utils.getConversationKey(WRAPPER_SECRET_KEY, BOT_PUBLIC_KEY),
    nonce(12),
  );
  const wrap = finalizeEvent(
    {
      kind: 1059,
      content: wrapContent,
      tags: [
        ["p", BOT_PUBLIC_KEY],
        ["k", "14"],
      ],
      created_at: FIXTURE_NOW - 2_400,
      ...options.wrapTemplate,
    },
    WRAPPER_SECRET_KEY,
  );
  return options.wrapTransform?.(wrap) ?? wrap;
}

export function createRumor(
  overrides: Partial<UnsignedEvent> = {},
): FixtureRumor {
  const unsigned: UnsignedEvent = {
    kind: 14,
    content: "armada fixture plaintext",
    tags: [["p", BOT_PUBLIC_KEY]],
    created_at: FIXTURE_NOW - 60,
    pubkey: SENDER_PUBLIC_KEY,
    ...overrides,
  };
  return { ...unsigned, id: getEventHash(unsigned) };
}

export function resignWrap(
  wrap: NostrEvent,
  changes: Partial<EventTemplate>,
): NostrEvent {
  return finalizeEvent(
    {
      kind: wrap.kind,
      content: wrap.content,
      tags: wrap.tags.map((tag) => [...tag]),
      created_at: wrap.created_at,
      ...changes,
    },
    WRAPPER_SECRET_KEY,
  );
}

export function independentlyOpenWrap(
  wrap: NostrEvent,
  recipientSecretKey: Uint8Array,
): { seal: NostrEvent; rumor: FixtureRumor } {
  const seal = JSON.parse(
    nip44.v2.decrypt(
      wrap.content,
      nip44.v2.utils.getConversationKey(recipientSecretKey, wrap.pubkey),
    ),
  ) as NostrEvent;
  const rumor = JSON.parse(
    nip44.v2.decrypt(
      seal.content,
      nip44.v2.utils.getConversationKey(recipientSecretKey, seal.pubkey),
    ),
  ) as FixtureRumor;
  return { seal, rumor };
}

export function deterministicEntropy() {
  const secrets = [scalar(5), scalar(6)];
  const nonces = [nonce(21), nonce(22), nonce(23), nonce(24)];
  const offsets = [101, 202, 303, 404];
  return {
    generateSecretKey: () => {
      const next = secrets.shift();
      if (next === undefined) throw new Error("fixture entropy exhausted");
      return next;
    },
    generateNonce: () => {
      const next = nonces.shift();
      if (next === undefined) throw new Error("fixture entropy exhausted");
      return next;
    },
    randomTimestampOffset: () => {
      const next = offsets.shift();
      if (next === undefined) throw new Error("fixture entropy exhausted");
      return next;
    },
  };
}

function nonce(value: number): Uint8Array {
  return new Uint8Array(32).fill(value);
}
