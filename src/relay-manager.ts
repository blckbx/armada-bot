import { finalizeEvent, verifyEvent, type NostrEvent } from "nostr-tools/pure";
import {
  RelaySession,
  type RelayConnector,
  type RelaySessionLimits,
  type RelaySessionSnapshot,
} from "./relay-session.js";
import type { RelayDnsLookup } from "./relay-url-policy.js";
import { SECURITY_LIMITS, type SecurityLimits } from "./security-limits.js";

const HEX_32 = /^[0-9a-f]{64}$/u;

export class RelayTransportError extends Error {
  constructor(message = "Relay transport failed.") {
    super(message);
    this.name = "RelayTransportError";
  }
}

export interface RelayManagerSnapshot {
  readonly running: boolean;
  readonly ready: boolean;
  readonly health: "stopped" | "starting" | "healthy" | "degraded";
  readonly announcementVerified: boolean;
  readonly configuredInboxRelays: number;
  readonly connectedInboxRelays: number;
  readonly liveSubscriptions: number;
  readonly partiallyAvailable: boolean;
  readonly dedupeAvailable: boolean;
  readonly queuedInboundEvents: number;
  readonly activeInboundHandlers: number;
  readonly droppedInboundEvents: number;
  readonly rateLimitedInboundEvents: number;
  readonly relays: RelaySessionSnapshot[];
  readonly lastError?: string | undefined;
}

export type RelayManagerLimits = Pick<
  SecurityLimits,
  "pendingInboundEvents" | "concurrentInboundHandlers" | "overallSendTimeoutMs"
> &
  RelaySessionLimits;

export interface RelayManagerOptions {
  readonly inboxRelays: string[];
  readonly discoveryRelays: string[];
  readonly publishInbox: boolean;
  readonly allowPrivateRelays: boolean;
  readonly identity: {
    readonly secretKey: Uint8Array;
    readonly publicKey: string;
  };
  readonly recoveryLookbackSeconds: number;
  readonly maxMessageAgeSeconds: number;
  readonly maxFutureSkewSeconds: number;
  readonly onEvent: (event: NostrEvent) => Promise<void> | void;
  readonly onStatus?: (snapshot: RelayManagerSnapshot) => void;
  readonly nowSeconds?: () => number;
  readonly lookup?: RelayDnsLookup;
  readonly connector?: RelayConnector;
  readonly limits?: Partial<RelayManagerLimits>;
}

export interface RelayPublicationResult {
  readonly successfulRelays: string[];
  readonly failedRelayCount: number;
}

export interface RelayPublicationOptions {
  readonly source?: "configured" | "recipient";
}

export class RelayManager {
  private readonly options: RelayManagerOptions;
  private readonly limits: RelayManagerLimits;
  private readonly inboxRelays: string[];
  private readonly discoveryRelays: string[];
  private readonly sessions = new Map<string, RelaySession>();
  private readonly temporarySessions = new Set<RelaySession>();
  private readonly inboundQueue: NostrEvent[] = [];
  private readonly handlerTasks = new Set<Promise<void>>();
  private readonly nowSeconds: () => number;

  private active = false;
  private generation = 0;
  private activeInboundHandlers = 0;
  private droppedInboundEvents = 0;
  private rateLimitedInboundEvents = 0;
  private dedupeAvailable = true;
  private announcementVerified = false;
  private managerError: string | undefined;
  private startPromise: Promise<void> | undefined;
  private stopPromise: Promise<void> | undefined;
  private currentSnapshot: RelayManagerSnapshot;

  constructor(options: RelayManagerOptions) {
    this.options = options;
    this.limits = resolveLimits(options.limits);
    this.inboxRelays = uniqueRelays(options.inboxRelays);
    this.discoveryRelays = uniqueRelays(options.discoveryRelays);
    if (
      this.inboxRelays.length === 0 ||
      this.discoveryRelays.length === 0 ||
      this.inboxRelays.length > SECURITY_LIMITS.configuredRelays ||
      this.discoveryRelays.length > SECURITY_LIMITS.configuredRelays
    ) {
      throw new RelayTransportError();
    }
    this.nowSeconds =
      options.nowSeconds ?? (() => Math.floor(Date.now() / 1_000));
    this.currentSnapshot = {
      running: false,
      ready: false,
      health: "stopped",
      announcementVerified: false,
      configuredInboxRelays: this.inboxRelays.length,
      connectedInboxRelays: 0,
      liveSubscriptions: 0,
      partiallyAvailable: false,
      dedupeAvailable: true,
      queuedInboundEvents: 0,
      activeInboundHandlers: 0,
      droppedInboundEvents: 0,
      rateLimitedInboundEvents: 0,
      relays: [],
    };
  }

  snapshot(): RelayManagerSnapshot {
    return {
      ...this.currentSnapshot,
      relays: this.currentSnapshot.relays.map((relay) => ({ ...relay })),
    };
  }

  start(): Promise<void> {
    if (this.stopPromise !== undefined)
      return this.stopPromise.then(() => this.start());
    if (this.active) return this.startPromise ?? Promise.resolve();
    this.active = true;
    const generation = ++this.generation;
    this.managerError = undefined;
    this.dedupeAvailable = true;
    this.announcementVerified = !this.options.publishInbox;
    this.refreshSnapshot("starting");

    for (const relayUrl of this.inboxRelays) {
      const session = this.createSession(relayUrl, true, generation);
      this.sessions.set(relayUrl, session);
    }
    const start = this.startStrict(generation);
    this.startPromise = start;
    void start.finally(() => {
      if (this.startPromise === start) this.startPromise = undefined;
    });
    return start;
  }

  stop(): Promise<void> {
    if (this.stopPromise !== undefined) return this.stopPromise;
    if (!this.active) return Promise.resolve();
    const stop = this.stopStrict();
    this.stopPromise = stop;
    void stop.finally(() => {
      if (this.stopPromise === stop) this.stopPromise = undefined;
    });
    return stop;
  }

  markInboundRateLimited(): void {
    if (!this.active) return;
    this.rateLimitedInboundEvents += 1;
    this.refreshSnapshot();
  }

  async publishToAtLeastOne(
    relayUrls: string[],
    event: NostrEvent,
    options: RelayPublicationOptions = {},
  ): Promise<RelayPublicationResult> {
    const maximumRelays =
      options.source === "recipient"
        ? SECURITY_LIMITS.recipientDeliveryRelays
        : SECURITY_LIMITS.configuredRelays;
    if (
      !this.active ||
      relayUrls.length === 0 ||
      relayUrls.length > maximumRelays
    ) {
      throw new RelayTransportError("Relay publication failed.");
    }
    const unique = uniqueRelays(relayUrls);
    const operation = Promise.allSettled(
      unique.map(async (relayUrl) => {
        const { session, temporary } = await this.resolvePublishingSession(
          relayUrl,
          options.source ?? "configured",
        );
        try {
          await session.publish(event);
          return relayUrl;
        } finally {
          if (temporary) {
            this.temporarySessions.delete(session);
            await session.stop();
          }
        }
      }),
    );
    const results = await withOverallTimeout(
      operation,
      this.limits.overallSendTimeoutMs,
    );
    const successfulRelays = results.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
    if (successfulRelays.length === 0) {
      throw new RelayTransportError("Relay publication failed.");
    }
    return {
      successfulRelays,
      failedRelayCount: results.length - successfulRelays.length,
    };
  }

  async queryRelays(
    relayUrls: string[],
    filter: Record<string, unknown>,
  ): Promise<NostrEvent[]> {
    if (
      !this.active ||
      relayUrls.length === 0 ||
      relayUrls.length > SECURITY_LIMITS.configuredRelays
    ) {
      throw new RelayTransportError("Relay query failed.");
    }
    const results = await Promise.allSettled(
      uniqueRelays(relayUrls).map(async (relayUrl) => {
        const { session, temporary } = await this.resolvePublishingSession(
          relayUrl,
          "configured",
        );
        try {
          return await session.query(filter);
        } finally {
          if (temporary) {
            this.temporarySessions.delete(session);
            await session.stop();
          }
        }
      }),
    );
    const successful = results.filter(
      (result): result is PromiseFulfilledResult<NostrEvent[]> =>
        result.status === "fulfilled",
    );
    if (successful.length === 0) {
      throw new RelayTransportError("Relay query failed.");
    }
    const events = new Map<string, NostrEvent>();
    for (const result of successful) {
      for (const event of result.value) events.set(event.id, cloneEvent(event));
    }
    return [...events.values()];
  }

  markIntakeDegraded(): void {
    if (!this.active) return;
    this.dedupeAvailable = false;
    this.managerError = "Replay protection is unavailable.";
    this.refreshSnapshot("degraded");
  }

  private async startStrict(generation: number): Promise<void> {
    await Promise.allSettled(
      [...this.sessions.values()].map(async (session) => session.start()),
    );
    if (!this.isCurrent(generation)) return;
    if (this.options.publishInbox) {
      try {
        await this.publishAndVerifyInboxAnnouncement(generation);
      } catch {
        if (this.isCurrent(generation)) {
          this.announcementVerified = false;
          this.managerError = "Relay publication failed.";
        }
      }
    }
    this.refreshSnapshot();
  }

  private async publishAndVerifyInboxAnnouncement(
    generation: number,
  ): Promise<void> {
    const announcement = createInboxAnnouncement({
      secretKey: this.options.identity.secretKey,
      inboxRelays: this.inboxRelays,
      now: this.nowSeconds(),
    });
    await this.publishToAtLeastOne(this.discoveryRelays, announcement);
    if (!this.isCurrent(generation)) return;
    const filter = {
      kinds: [10_050],
      authors: [this.options.identity.publicKey],
      limit: 1,
    };
    const results = await Promise.allSettled(
      this.discoveryRelays.map(async (relayUrl) => {
        const { session, temporary } = await this.resolvePublishingSession(
          relayUrl,
          "configured",
        );
        try {
          const events = await session.query(filter);
          return events.some((event) =>
            verifyInboxAnnouncement(event, {
              botPublicKey: this.options.identity.publicKey,
              inboxRelays: this.inboxRelays,
              now: this.nowSeconds(),
              maxFutureSkewSeconds: this.options.maxFutureSkewSeconds,
            }),
          );
        } finally {
          if (temporary) {
            this.temporarySessions.delete(session);
            await session.stop();
          }
        }
      }),
    );
    if (!this.isCurrent(generation)) return;
    this.announcementVerified = results.some(
      (result) => result.status === "fulfilled" && result.value,
    );
    if (!this.announcementVerified) throw new RelayTransportError();
  }

  private createSession(
    relayUrl: string,
    withSubscription: boolean,
    generation: number,
    relaySource: "configured" | "recipient" = "configured",
  ): RelaySession {
    const since =
      this.nowSeconds() -
      this.options.recoveryLookbackSeconds -
      SECURITY_LIMITS.nip59TimestampWindowSeconds;
    return new RelaySession({
      relayUrl,
      identity: this.options.identity,
      allowPrivateRelays: this.options.allowPrivateRelays,
      relaySource,
      ...(withSubscription
        ? {
            subscription: {
              recipientPublicKey: this.options.identity.publicKey,
              since,
              maxMessageAgeSeconds: this.options.maxMessageAgeSeconds,
              maxFutureSkewSeconds: this.options.maxFutureSkewSeconds,
            },
            onEvent: (event: NostrEvent) =>
              this.enqueueInbound(event, generation),
          }
        : {}),
      onStatus: () => {
        if (this.isCurrent(generation)) this.refreshSnapshot();
      },
      nowSeconds: this.nowSeconds,
      ...(this.options.lookup === undefined
        ? {}
        : { lookup: this.options.lookup }),
      ...(this.options.connector === undefined
        ? {}
        : { connector: this.options.connector }),
      limits: sessionLimits(this.limits),
    });
  }

  private async resolvePublishingSession(
    relayUrl: string,
    relaySource: "configured" | "recipient",
  ): Promise<{ session: RelaySession; temporary: boolean }> {
    const standing =
      relaySource === "configured" ? this.sessions.get(relayUrl) : undefined;
    if (standing?.snapshot().state === "connected") {
      return { session: standing, temporary: false };
    }
    const session = this.createSession(
      relayUrl,
      false,
      this.generation,
      relaySource,
    );
    this.temporarySessions.add(session);
    await session.start();
    if (session.snapshot().state !== "connected") {
      this.temporarySessions.delete(session);
      await session.stop();
      throw new RelayTransportError();
    }
    return { session, temporary: true };
  }

  private enqueueInbound(event: NostrEvent, generation: number): void {
    if (!this.isCurrent(generation)) return;
    if (this.activeInboundHandlers < this.limits.concurrentInboundHandlers) {
      this.runInbound(event, generation);
      return;
    }
    if (this.inboundQueue.length >= this.limits.pendingInboundEvents) {
      this.droppedInboundEvents += 1;
      this.refreshSnapshot();
      return;
    }
    this.inboundQueue.push(cloneEvent(event));
    this.refreshSnapshot();
  }

  private runInbound(event: NostrEvent, generation: number): void {
    this.activeInboundHandlers += 1;
    this.refreshSnapshot();
    const task = Promise.resolve(this.options.onEvent(cloneEvent(event)))
      .catch(() => undefined)
      .then(() => {
        this.activeInboundHandlers -= 1;
        if (this.isCurrent(generation)) {
          const next = this.inboundQueue.shift();
          if (next !== undefined) this.runInbound(next, generation);
          else this.refreshSnapshot();
        }
      });
    this.handlerTasks.add(task);
    void task.finally(() => this.handlerTasks.delete(task));
  }

  private async stopStrict(): Promise<void> {
    this.active = false;
    this.generation += 1;
    this.inboundQueue.length = 0;
    const sessions = [...this.sessions.values(), ...this.temporarySessions];
    await Promise.allSettled(sessions.map(async (session) => session.stop()));
    await Promise.allSettled([...this.handlerTasks]);
    this.sessions.clear();
    this.temporarySessions.clear();
    this.handlerTasks.clear();
    this.activeInboundHandlers = 0;
    this.announcementVerified = false;
    this.managerError = undefined;
    this.dedupeAvailable = true;
    this.refreshSnapshot("stopped");
  }

  private isCurrent(generation: number): boolean {
    return this.active && this.generation === generation;
  }

  private refreshSnapshot(forcedHealth?: RelayManagerSnapshot["health"]): void {
    const relays = [...this.sessions.values()].map((session) =>
      session.snapshot(),
    );
    const liveSubscriptions = relays.filter(
      (relay) => relay.subscriptionLive,
    ).length;
    const connectedInboxRelays = relays.filter(
      (relay) => relay.state === "connected",
    ).length;
    const partiallyAvailable =
      liveSubscriptions > 0 && liveSubscriptions < this.inboxRelays.length;
    const ready =
      this.active &&
      this.managerError === undefined &&
      liveSubscriptions > 0 &&
      (!this.options.publishInbox || this.announcementVerified);
    const health =
      forcedHealth ??
      (ready
        ? partiallyAvailable
          ? "degraded"
          : "healthy"
        : this.active
          ? "degraded"
          : "stopped");
    const next: RelayManagerSnapshot = {
      running: this.active,
      ready,
      health,
      announcementVerified: this.announcementVerified,
      configuredInboxRelays: this.inboxRelays.length,
      connectedInboxRelays,
      liveSubscriptions,
      partiallyAvailable,
      dedupeAvailable: this.dedupeAvailable,
      queuedInboundEvents: this.inboundQueue.length,
      activeInboundHandlers: this.activeInboundHandlers,
      droppedInboundEvents: this.droppedInboundEvents,
      rateLimitedInboundEvents: this.rateLimitedInboundEvents,
      relays,
      ...(this.managerError === undefined
        ? {}
        : { lastError: this.managerError }),
    };
    this.currentSnapshot = next;
    try {
      this.options.onStatus?.(this.snapshot());
    } catch {
      // Status observers cannot terminate relay lifecycle.
    }
  }
}

export function createInboxAnnouncement(input: {
  secretKey: Uint8Array;
  inboxRelays: string[];
  now: number;
}): NostrEvent {
  try {
    const relays = uniqueRelays(input.inboxRelays);
    if (
      relays.length === 0 ||
      relays.length > SECURITY_LIMITS.configuredRelays ||
      !Number.isSafeInteger(input.now) ||
      input.now < 0
    ) {
      throw new RelayTransportError();
    }
    return cloneEvent(
      finalizeEvent(
        {
          kind: 10_050,
          content: "",
          tags: relays.map((relay) => ["relay", relay]),
          created_at: input.now,
        },
        input.secretKey,
      ),
    );
  } catch {
    throw new RelayTransportError("Inbox announcement failed.");
  }
}

export function verifyInboxAnnouncement(
  value: unknown,
  expected: {
    botPublicKey: string;
    inboxRelays: string[];
    now: number;
    maxFutureSkewSeconds: number;
  },
): boolean {
  try {
    if (
      !isNostrEvent(value) ||
      value.kind !== 10_050 ||
      value.content !== "" ||
      value.pubkey !== expected.botPublicKey ||
      !HEX_32.test(value.pubkey) ||
      !Number.isSafeInteger(value.created_at) ||
      value.created_at < 0 ||
      value.created_at > expected.now + expected.maxFutureSkewSeconds ||
      !verifyEvent(cloneEvent(value))
    ) {
      return false;
    }
    const expectedRelays = uniqueRelays(expected.inboxRelays);
    const actualRelays = value.tags.flatMap((tag) =>
      tag.length === 2 && tag[0] === "relay" && tag[1] !== undefined
        ? [tag[1]]
        : [],
    );
    return (
      actualRelays.length === value.tags.length &&
      actualRelays.length === expectedRelays.length &&
      new Set(actualRelays).size === actualRelays.length &&
      actualRelays.every((relay) => expectedRelays.includes(relay))
    );
  } catch {
    return false;
  }
}

function resolveLimits(
  overrides: Partial<RelayManagerLimits> | undefined,
): RelayManagerLimits {
  const defaults: RelayManagerLimits = {
    pendingInboundEvents: SECURITY_LIMITS.pendingInboundEvents,
    concurrentInboundHandlers: SECURITY_LIMITS.concurrentInboundHandlers,
    overallSendTimeoutMs: SECURITY_LIMITS.overallSendTimeoutMs,
    rawIngressEnvelopeBytes: SECURITY_LIMITS.rawIngressEnvelopeBytes,
    authChallengeBytes: SECURITY_LIMITS.authChallengeBytes,
    queryResultEvents: SECURITY_LIMITS.queryResultEvents,
    connectTimeoutMs: SECURITY_LIMITS.connectTimeoutMs,
    websocketHandshakeTimeoutMs: SECURITY_LIMITS.websocketHandshakeTimeoutMs,
    authTimeoutMs: SECURITY_LIMITS.authTimeoutMs,
    publishAckTimeoutMs: SECURITY_LIMITS.publishAckTimeoutMs,
    queryTimeoutMs: SECURITY_LIMITS.queryTimeoutMs,
    initialReconnectDelayMs: SECURITY_LIMITS.initialReconnectDelayMs,
    maximumReconnectDelayMs: SECURITY_LIMITS.maximumReconnectDelayMs,
    stableConnectionMs: SECURITY_LIMITS.stableConnectionMs,
  };
  const resolved = { ...defaults, ...overrides };
  for (const key of Object.keys(defaults) as (keyof RelayManagerLimits)[]) {
    const value = resolved[key];
    if (!Number.isSafeInteger(value) || value < 1 || value > defaults[key]) {
      throw new RelayTransportError();
    }
  }
  return resolved;
}

function sessionLimits(limits: RelayManagerLimits): RelaySessionLimits {
  return {
    rawIngressEnvelopeBytes: limits.rawIngressEnvelopeBytes,
    authChallengeBytes: limits.authChallengeBytes,
    queryResultEvents: limits.queryResultEvents,
    connectTimeoutMs: limits.connectTimeoutMs,
    websocketHandshakeTimeoutMs: limits.websocketHandshakeTimeoutMs,
    authTimeoutMs: limits.authTimeoutMs,
    publishAckTimeoutMs: limits.publishAckTimeoutMs,
    queryTimeoutMs: limits.queryTimeoutMs,
    initialReconnectDelayMs: limits.initialReconnectDelayMs,
    maximumReconnectDelayMs: limits.maximumReconnectDelayMs,
    stableConnectionMs: limits.stableConnectionMs,
  };
}

function uniqueRelays(relays: string[]): string[] {
  return [...new Set(relays)];
}

function isNostrEvent(value: unknown): value is NostrEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const event = value as Record<string, unknown>;
  return (
    typeof event["kind"] === "number" &&
    Array.isArray(event["tags"]) &&
    event["tags"].every(
      (tag) =>
        Array.isArray(tag) &&
        tag.every((element) => typeof element === "string"),
    ) &&
    typeof event["content"] === "string" &&
    typeof event["created_at"] === "number" &&
    typeof event["pubkey"] === "string" &&
    typeof event["id"] === "string" &&
    typeof event["sig"] === "string"
  );
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

function withOverallTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new RelayTransportError()),
      timeoutMs,
    );
    void operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        reject(new RelayTransportError());
      },
    );
  });
}
