import { verifyEvent, type NostrEvent } from "nostr-tools/pure";
import { validateRelayUrl, type RelayDnsLookup } from "./relay-url-policy.js";
import { SECURITY_LIMITS } from "./security-limits.js";

const HEX_32 = /^[0-9a-f]{64}$/u;
const CACHE_TTL_MS = 60 * 60 * 1_000;
const CACHE_MAX_ENTRIES = 1_000;

export class RecipientRelayRoutingError extends Error {
  constructor() {
    super("No valid recipient inbox relays are available.");
    this.name = "RecipientRelayRoutingError";
  }
}

export type RelayEventQuery = (
  relayUrls: string[],
  filter: Record<string, unknown>,
) => Promise<NostrEvent[]>;

interface CacheEntry {
  readonly expiresAt: number;
  readonly relays: string[] | null;
}

export interface RecipientRelayRouterOptions {
  readonly discoveryRelays: string[];
  readonly fallbackRelays: string[];
  readonly allowFallbackDelivery: boolean;
  readonly maxFutureSkewSeconds: number;
  readonly query: RelayEventQuery;
  readonly lookup?: RelayDnsLookup;
  readonly nowSeconds?: () => number;
  readonly nowMilliseconds?: () => number;
}

export class RecipientRelayRouter {
  private readonly options: RecipientRelayRouterOptions;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly nowSeconds: () => number;
  private readonly nowMilliseconds: () => number;

  constructor(options: RecipientRelayRouterOptions) {
    this.options = options;
    this.nowSeconds =
      options.nowSeconds ?? (() => Math.floor(Date.now() / 1_000));
    this.nowMilliseconds = options.nowMilliseconds ?? Date.now;
  }

  async resolve(recipientPublicKey: string): Promise<string[]> {
    if (!HEX_32.test(recipientPublicKey))
      throw new RecipientRelayRoutingError();
    const cached = this.readCache(recipientPublicKey);
    if (cached !== undefined) return this.resolveCached(cached);

    let events: NostrEvent[];
    try {
      events = await this.options.query(this.options.discoveryRelays, {
        kinds: [10_050],
        authors: [recipientPublicKey],
        limit: 16,
      });
    } catch {
      throw new RecipientRelayRoutingError();
    }
    const ordered = events
      .filter(
        (event) =>
          event.kind === 10_050 &&
          event.pubkey === recipientPublicKey &&
          event.content === "" &&
          Number.isSafeInteger(event.created_at) &&
          event.created_at >= 0 &&
          event.created_at <=
            this.nowSeconds() + this.options.maxFutureSkewSeconds &&
          verifyEvent(cloneEvent(event)),
      )
      .sort((left, right) => right.created_at - left.created_at);

    for (const event of ordered) {
      const relays = await this.validateEventRelays(event);
      if (relays.length > 0) {
        this.writeCache(recipientPublicKey, relays);
        return [...relays];
      }
    }
    this.writeCache(recipientPublicKey, null);
    return this.resolveCached(null);
  }

  private async validateEventRelays(event: NostrEvent): Promise<string[]> {
    const rawRelays = event.tags.flatMap((tag) =>
      tag.length === 2 && tag[0] === "relay" && tag[1] !== undefined
        ? [tag[1]]
        : [],
    );
    const validated: string[] = [];
    for (const raw of rawRelays) {
      if (validated.length >= SECURITY_LIMITS.recipientDeliveryRelays) break;
      try {
        const target = await validateRelayUrl({
          url: raw,
          source: "recipient",
          allowPrivateRelays: false,
          ...(this.options.lookup === undefined
            ? {}
            : { lookup: this.options.lookup }),
        });
        if (!validated.includes(target.url)) validated.push(target.url);
      } catch {
        // One unusable tag does not invalidate other valid recipient relays.
      }
    }
    return validated;
  }

  private resolveCached(relays: string[] | null): string[] {
    if (relays !== null) return [...relays];
    if (
      this.options.allowFallbackDelivery &&
      this.options.fallbackRelays.length > 0
    ) {
      return [...this.options.fallbackRelays];
    }
    throw new RecipientRelayRoutingError();
  }

  private readCache(recipientPublicKey: string): string[] | null | undefined {
    const entry = this.cache.get(recipientPublicKey);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= this.nowMilliseconds()) {
      this.cache.delete(recipientPublicKey);
      return undefined;
    }
    return entry.relays === null ? null : [...entry.relays];
  }

  private writeCache(
    recipientPublicKey: string,
    relays: string[] | null,
  ): void {
    if (!this.cache.has(recipientPublicKey)) {
      while (this.cache.size >= CACHE_MAX_ENTRIES) {
        const oldest = this.cache.keys().next().value;
        if (oldest === undefined) break;
        this.cache.delete(oldest);
      }
    }
    this.cache.set(recipientPublicKey, {
      expiresAt: this.nowMilliseconds() + CACHE_TTL_MS,
      relays: relays === null ? null : [...relays],
    });
  }
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
