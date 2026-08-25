import { type LookupFunction } from "node:net";
import {
  finalizeEvent,
  verifyEvent,
  type EventTemplate,
  type NostrEvent,
} from "nostr-tools/pure";
import WebSocket, { type RawData } from "ws";
import { validateGiftWrapCarrier } from "./nip17.js";
import {
  RelayUrlPolicyError,
  validateRelayUrl,
  type RelayDnsLookup,
  type ValidatedRelayTarget,
} from "./relay-url-policy.js";
import { SECURITY_LIMITS, type SecurityLimits } from "./security-limits.js";

const UTF8 = new TextEncoder();
const AUTH_KIND = 22_242;

export class RelaySessionError extends Error {
  constructor(message = "Relay operation failed.") {
    super(message);
    this.name = "RelaySessionError";
  }
}

export type RelaySessionState =
  "connecting" | "connected" | "reconnecting" | "disconnected";

export interface RelaySessionSnapshot {
  readonly relayUrl: string;
  readonly state: RelaySessionState;
  readonly reconnectAttempts: number;
  readonly authenticated: boolean;
  readonly subscriptionLive: boolean;
  readonly lastError?: string | undefined;
}

export interface RelaySubscriptionOptions {
  readonly recipientPublicKey: string;
  readonly since: number;
  readonly maxMessageAgeSeconds: number;
  readonly maxFutureSkewSeconds: number;
}

export type RelaySessionLimits = Pick<
  SecurityLimits,
  | "rawIngressEnvelopeBytes"
  | "authChallengeBytes"
  | "queryResultEvents"
  | "connectTimeoutMs"
  | "websocketHandshakeTimeoutMs"
  | "authTimeoutMs"
  | "publishAckTimeoutMs"
  | "queryTimeoutMs"
  | "initialReconnectDelayMs"
  | "maximumReconnectDelayMs"
  | "stableConnectionMs"
>;

export interface RelayWire {
  send(frame: string): void;
  close(): void;
}

export interface RelayWireHandlers {
  readonly onMessage: (frame: string) => void;
  readonly onClose: () => void;
  readonly onError: () => void;
}

export type RelayConnector = (
  target: ValidatedRelayTarget,
  handlers: RelayWireHandlers,
  signal: AbortSignal,
  limits: RelaySessionLimits,
) => Promise<RelayWire>;

export interface RelaySessionOptions {
  readonly relayUrl: string;
  readonly identity: {
    readonly secretKey: Uint8Array;
    readonly publicKey: string;
  };
  readonly allowPrivateRelays: boolean;
  readonly relaySource?: "configured" | "recipient";
  readonly subscription?: RelaySubscriptionOptions;
  readonly onEvent?: (event: NostrEvent) => Promise<void> | void;
  readonly onStatus?: (snapshot: RelaySessionSnapshot) => void;
  readonly lookup?: RelayDnsLookup;
  readonly connector?: RelayConnector;
  readonly nowSeconds?: () => number;
  readonly nowMilliseconds?: () => number;
  readonly random?: () => number;
  readonly signAuthEvent?: (template: EventTemplate) => Promise<NostrEvent>;
  readonly limits?: Partial<RelaySessionLimits>;
}

interface ChallengeToken {
  readonly value: string;
  readonly generation: number;
  readonly connectionId: number;
  readonly expiresAt: number;
}

interface PendingOk {
  readonly resolve: (result: RelayOkResult) => void;
  readonly reject: (error: RelaySessionError) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface RelayOkResult {
  readonly accepted: boolean;
  readonly message: string;
}

interface PendingQuery {
  readonly events: NostrEvent[];
  readonly resolve: (events: NostrEvent[]) => void;
  readonly reject: (error: RelaySessionError) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export class RelaySession {
  private readonly options: RelaySessionOptions;
  private readonly limits: RelaySessionLimits;
  private readonly connector: RelayConnector;
  private readonly nowSeconds: () => number;
  private readonly nowMilliseconds: () => number;
  private readonly random: () => number;
  private readonly signAuthEvent: (
    template: EventTemplate,
  ) => Promise<NostrEvent>;
  private readonly pendingOk = new Map<string, PendingOk>();
  private readonly pendingQueries = new Map<string, PendingQuery>();
  private readonly tasks = new Set<Promise<unknown>>();

  private currentSnapshot: RelaySessionSnapshot;
  private active = false;
  private generation = 0;
  private connectionSequence = 0;
  private activeConnectionId = 0;
  private wire: RelayWire | undefined;
  private connectionController: AbortController | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private stableTimer: ReturnType<typeof setTimeout> | undefined;
  private startPromise: Promise<void> | undefined;
  private stopPromise: Promise<void> | undefined;
  private challenge: ChallengeToken | undefined;
  private authPromise: Promise<void> | undefined;
  private querySequence = 0;

  constructor(options: RelaySessionOptions) {
    this.options = options;
    this.limits = resolveLimits(options.limits);
    this.connector = options.connector ?? connectWebSocket;
    this.nowSeconds =
      options.nowSeconds ?? (() => Math.floor(Date.now() / 1_000));
    this.nowMilliseconds = options.nowMilliseconds ?? Date.now;
    this.random = options.random ?? Math.random;
    this.signAuthEvent =
      options.signAuthEvent ??
      ((template) =>
        Promise.resolve(finalizeEvent(template, options.identity.secretKey)));
    this.currentSnapshot = {
      relayUrl: options.relayUrl,
      state: "disconnected",
      reconnectAttempts: 0,
      authenticated: false,
      subscriptionLive: false,
    };
  }

  snapshot(): RelaySessionSnapshot {
    return { ...this.currentSnapshot };
  }

  start(): Promise<void> {
    if (this.stopPromise !== undefined)
      return this.stopPromise.then(() => this.start());
    if (this.active) return this.startPromise ?? Promise.resolve();
    this.active = true;
    const generation = ++this.generation;
    this.update({
      state: "connecting",
      reconnectAttempts: 0,
      authenticated: false,
      subscriptionLive: false,
      lastError: undefined,
    });
    const start = this.connect(generation);
    this.startPromise = start;
    void start.finally(() => {
      if (this.startPromise === start) this.startPromise = undefined;
    });
    return start;
  }

  stop(): Promise<void> {
    if (this.stopPromise !== undefined) return this.stopPromise;
    if (!this.active) return Promise.resolve();
    const stopping = this.stopStrict();
    this.stopPromise = stopping;
    void stopping.finally(() => {
      if (this.stopPromise === stopping) this.stopPromise = undefined;
    });
    return stopping;
  }

  async publish(event: NostrEvent): Promise<void> {
    try {
      const first = await this.sendEventAndWait(event);
      if (first.accepted) return;
      if (!isAuthRequired(first.message))
        throw new RelaySessionError("Relay publication failed.");
      await this.ensureAuthenticated();
      const retried = await this.sendEventAndWait(event);
      if (!retried.accepted)
        throw new RelaySessionError("Relay publication failed.");
    } catch {
      throw new RelaySessionError("Relay publication failed.");
    }
  }

  async query(filter: Record<string, unknown>): Promise<NostrEvent[]> {
    try {
      return await this.queryAttempt(filter, true);
    } catch (error) {
      if (!(error instanceof AuthRequiredError)) {
        throw new RelaySessionError("Relay query failed.");
      }
      try {
        await this.ensureAuthenticated();
        return await this.queryAttempt(filter, false);
      } catch {
        throw new RelaySessionError("Relay query failed.");
      }
    }
  }

  private async connect(generation: number): Promise<void> {
    let target: ValidatedRelayTarget;
    try {
      target = await validateRelayUrl({
        url: this.options.relayUrl,
        source: this.options.relaySource ?? "configured",
        allowPrivateRelays: this.options.allowPrivateRelays,
        ...(this.options.lookup === undefined
          ? {}
          : { lookup: this.options.lookup }),
      });
    } catch (error) {
      if (error instanceof RelayUrlPolicyError && this.isCurrent(generation)) {
        this.active = false;
        this.update({
          state: "disconnected",
          authenticated: false,
          subscriptionLive: false,
          lastError: "Relay connection failed.",
        });
      }
      return;
    }
    if (!this.isCurrent(generation)) return;

    const controller = new AbortController();
    const connectionId = ++this.connectionSequence;
    this.activeConnectionId = connectionId;
    this.connectionController = controller;
    try {
      const wire = await withTimeout(
        this.connector(
          target,
          {
            onMessage: (frame) =>
              this.handleFrame(frame, generation, connectionId),
            onClose: () => this.handleClose(generation, connectionId),
            onError: () => undefined,
          },
          controller.signal,
          this.limits,
        ),
        this.limits.connectTimeoutMs,
        () => controller.abort(),
      );
      if (!this.isConnectionCurrent(generation, connectionId)) {
        wire.close();
        return;
      }
      this.wire = wire;
      this.update({
        relayUrl: target.url,
        state: "connected",
        authenticated: false,
        subscriptionLive: false,
        lastError: undefined,
      });
      this.scheduleStableReset(generation);
      if (
        this.challenge !== undefined &&
        this.isChallengeCurrent(this.challenge)
      ) {
        this.startAuthentication(this.challenge);
      }
      if (this.options.subscription !== undefined) this.sendInboxSubscription();
    } catch {
      if (this.isCurrent(generation)) this.scheduleReconnect(generation);
    } finally {
      if (this.connectionController === controller)
        this.connectionController = undefined;
    }
  }

  private handleFrame(
    raw: string,
    generation: number,
    connectionId: number,
  ): void {
    if (
      !this.isConnectionCurrent(generation, connectionId) ||
      UTF8.encode(raw).byteLength > this.limits.rawIngressEnvelopeBytes
    ) {
      return;
    }
    let frame: unknown;
    try {
      frame = JSON.parse(raw) as unknown;
    } catch {
      return;
    }
    if (!Array.isArray(frame) || typeof frame[0] !== "string") return;

    if (frame[0] === "AUTH") {
      this.handleChallenge(frame[1], generation, connectionId);
      return;
    }
    if (frame[0] === "OK") {
      this.handleOk(frame);
      return;
    }
    if (frame[0] === "EOSE" && typeof frame[1] === "string") {
      this.handleEose(frame[1]);
      return;
    }
    if (frame[0] === "CLOSED" && typeof frame[1] === "string") {
      this.handleClosed(frame[1], typeof frame[2] === "string" ? frame[2] : "");
      return;
    }
    if (frame[0] === "EVENT" && typeof frame[1] === "string") {
      this.handleEvent(frame[1], frame[2]);
    }
  }

  private handleChallenge(
    value: unknown,
    generation: number,
    connectionId: number,
  ): void {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      UTF8.encode(value).byteLength > this.limits.authChallengeBytes
    ) {
      return;
    }
    const token: ChallengeToken = {
      value,
      generation,
      connectionId,
      expiresAt: this.nowMilliseconds() + this.limits.authTimeoutMs,
    };
    this.challenge = token;
    this.update({ authenticated: false });
    if (this.wire === undefined) return;
    this.startAuthentication(token);
  }

  private startAuthentication(token: ChallengeToken): void {
    const task = Promise.resolve().then(async () => this.authenticate(token));
    this.authPromise = task;
    void this.track(
      task.catch(() => {
        if (
          this.challenge === token &&
          this.isConnectionCurrent(token.generation, token.connectionId)
        ) {
          this.update({
            authenticated: false,
            lastError: "Relay authentication failed.",
          });
        }
      }),
    );
  }

  private async authenticate(token: ChallengeToken): Promise<void> {
    const template: EventTemplate = {
      kind: AUTH_KIND,
      content: "",
      tags: [
        ["relay", this.currentSnapshot.relayUrl],
        ["challenge", token.value],
      ],
      created_at: this.nowSeconds(),
    };
    const signed = await this.signAuthEvent(template);
    if (
      !this.isChallengeCurrent(token) ||
      signed.kind !== AUTH_KIND ||
      signed.pubkey !== this.options.identity.publicKey ||
      signed.content !== "" ||
      !hasExactTag(signed.tags, "relay", this.currentSnapshot.relayUrl) ||
      !hasExactTag(signed.tags, "challenge", token.value) ||
      !verifyEvent(cloneEvent(signed))
    ) {
      throw new RelaySessionError("Relay authentication failed.");
    }
    const result = await this.sendAndWaitForOk(
      "AUTH",
      signed,
      this.limits.authTimeoutMs,
    );
    if (!result.accepted || !this.isChallengeCurrent(token)) {
      throw new RelaySessionError("Relay authentication failed.");
    }
    this.update({ authenticated: true, lastError: undefined });
  }

  private async ensureAuthenticated(): Promise<void> {
    if (this.currentSnapshot.authenticated) return;
    const token = this.challenge;
    if (token === undefined || !this.isChallengeCurrent(token)) {
      throw new RelaySessionError("Relay authentication failed.");
    }
    const current = this.authPromise;
    if (current !== undefined) await current;
    else await this.authenticate(token);
  }

  private isChallengeCurrent(token: ChallengeToken): boolean {
    return (
      this.challenge === token &&
      this.isConnectionCurrent(token.generation, token.connectionId) &&
      this.nowMilliseconds() <= token.expiresAt
    );
  }

  private sendInboxSubscription(): void {
    const subscription = this.options.subscription;
    if (subscription === undefined || this.wire === undefined || !this.active)
      return;
    this.update({ subscriptionLive: false });
    this.wire.send(
      JSON.stringify([
        "REQ",
        "armada-inbox",
        {
          kinds: [1059],
          "#p": [subscription.recipientPublicKey],
          since: subscription.since,
        },
      ]),
    );
  }

  private handleEose(subscriptionId: string): void {
    if (subscriptionId === "armada-inbox") {
      this.update({ subscriptionLive: true, lastError: undefined });
      return;
    }
    const query = this.pendingQueries.get(subscriptionId);
    if (query === undefined) return;
    this.pendingQueries.delete(subscriptionId);
    clearTimeout(query.timer);
    this.sendClose(subscriptionId);
    query.resolve(query.events.map(cloneEvent));
  }

  private handleClosed(subscriptionId: string, message: string): void {
    if (subscriptionId === "armada-inbox") {
      this.update({ subscriptionLive: false });
      if (isAuthRequired(message)) {
        void this.track(
          this.ensureAuthenticated()
            .then(() => this.sendInboxSubscription())
            .catch(() => undefined),
        );
      }
      return;
    }
    const query = this.pendingQueries.get(subscriptionId);
    if (query === undefined) return;
    this.pendingQueries.delete(subscriptionId);
    clearTimeout(query.timer);
    query.reject(
      isAuthRequired(message)
        ? new AuthRequiredError()
        : new RelaySessionError("Relay query failed."),
    );
  }

  private handleEvent(subscriptionId: string, value: unknown): void {
    const query = this.pendingQueries.get(subscriptionId);
    if (query !== undefined) {
      if (
        isNostrEvent(value) &&
        query.events.length < this.limits.queryResultEvents
      ) {
        query.events.push(cloneEvent(value));
      }
      return;
    }
    const subscription = this.options.subscription;
    if (
      subscriptionId !== "armada-inbox" ||
      subscription === undefined ||
      this.options.onEvent === undefined
    ) {
      return;
    }
    try {
      const event = validateGiftWrapCarrier({
        wrap: value,
        recipientPublicKey: subscription.recipientPublicKey,
        now: this.nowSeconds(),
        maxMessageAgeSeconds: subscription.maxMessageAgeSeconds,
        maxFutureSkewSeconds: subscription.maxFutureSkewSeconds,
      });
      const task = Promise.resolve(this.options.onEvent(event)).catch(
        () => undefined,
      );
      void this.track(task);
    } catch {
      // Invalid relay traffic is ignored without affecting the session.
    }
  }

  private handleOk(frame: unknown[]): void {
    const eventId = frame[1];
    const accepted = frame[2];
    const message = frame[3];
    if (typeof eventId !== "string" || typeof accepted !== "boolean") return;
    const pending = this.pendingOk.get(eventId);
    if (pending === undefined) return;
    this.pendingOk.delete(eventId);
    clearTimeout(pending.timer);
    pending.resolve({
      accepted,
      message: typeof message === "string" ? message : "",
    });
  }

  private async sendEventAndWait(event: NostrEvent): Promise<RelayOkResult> {
    return this.sendAndWaitForOk(
      "EVENT",
      event,
      this.limits.publishAckTimeoutMs,
    );
  }

  private sendAndWaitForOk(
    verb: "AUTH" | "EVENT",
    event: NostrEvent,
    timeoutMs: number,
  ): Promise<RelayOkResult> {
    const wire = this.wire;
    if (
      !this.active ||
      wire === undefined ||
      this.currentSnapshot.state !== "connected"
    ) {
      return Promise.reject(new RelaySessionError());
    }
    const existing = this.pendingOk.get(event.id);
    if (existing !== undefined) {
      clearTimeout(existing.timer);
      existing.reject(new RelaySessionError());
      this.pendingOk.delete(event.id);
    }
    return new Promise<RelayOkResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingOk.delete(event.id);
        reject(new RelaySessionError());
      }, timeoutMs);
      this.pendingOk.set(event.id, { resolve, reject, timer });
      try {
        wire.send(JSON.stringify([verb, event]));
      } catch {
        clearTimeout(timer);
        this.pendingOk.delete(event.id);
        reject(new RelaySessionError());
      }
    });
  }

  private queryAttempt(
    filter: Record<string, unknown>,
    canRequestAuth: boolean,
  ): Promise<NostrEvent[]> {
    const wire = this.wire;
    if (
      !this.active ||
      wire === undefined ||
      this.currentSnapshot.state !== "connected"
    ) {
      return Promise.reject(new RelaySessionError("Relay query failed."));
    }
    const subscriptionId = `armada-query-${String(++this.querySequence)}-${String(this.generation)}`;
    return new Promise<NostrEvent[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingQueries.delete(subscriptionId);
        this.sendClose(subscriptionId);
        reject(new RelaySessionError("Relay query failed."));
      }, this.limits.queryTimeoutMs);
      this.pendingQueries.set(subscriptionId, {
        events: [],
        resolve,
        reject: (error) =>
          reject(
            canRequestAuth && error instanceof AuthRequiredError
              ? error
              : new RelaySessionError(),
          ),
        timer,
      });
      try {
        wire.send(JSON.stringify(["REQ", subscriptionId, filter]));
      } catch {
        clearTimeout(timer);
        this.pendingQueries.delete(subscriptionId);
        reject(new RelaySessionError("Relay query failed."));
      }
    });
  }

  private handleClose(generation: number, connectionId: number): void {
    if (!this.isConnectionCurrent(generation, connectionId)) return;
    this.activeConnectionId = 0;
    this.wire = undefined;
    this.challenge = undefined;
    this.authPromise = undefined;
    this.clearStableTimer();
    this.rejectPending();
    this.scheduleReconnect(generation);
  }

  private scheduleReconnect(generation: number): void {
    if (!this.isCurrent(generation) || this.reconnectTimer !== undefined)
      return;
    this.wire = undefined;
    const attempts = this.currentSnapshot.reconnectAttempts + 1;
    const base = Math.min(
      this.limits.initialReconnectDelayMs * 2 ** (attempts - 1),
      this.limits.maximumReconnectDelayMs,
    );
    const jitter = Math.floor(base * 0.25 * clampRandom(this.random()));
    this.update({
      state: "reconnecting",
      reconnectAttempts: attempts,
      authenticated: false,
      subscriptionLive: false,
      lastError: "Relay connection failed.",
    });
    this.reconnectTimer = setTimeout(
      () => {
        this.reconnectTimer = undefined;
        if (!this.isCurrent(generation)) return;
        void this.connect(generation);
      },
      Math.min(base + jitter, this.limits.maximumReconnectDelayMs),
    );
  }

  private scheduleStableReset(generation: number): void {
    this.clearStableTimer();
    this.stableTimer = setTimeout(() => {
      this.stableTimer = undefined;
      if (
        this.isCurrent(generation) &&
        this.currentSnapshot.state === "connected"
      ) {
        this.update({ reconnectAttempts: 0 });
      }
    }, this.limits.stableConnectionMs);
  }

  private sendClose(subscriptionId: string): void {
    try {
      this.wire?.send(JSON.stringify(["CLOSE", subscriptionId]));
    } catch {
      // Local cleanup remains best effort.
    }
  }

  private async stopStrict(): Promise<void> {
    this.active = false;
    this.generation += 1;
    this.activeConnectionId = 0;
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.clearStableTimer();
    this.connectionController?.abort();
    this.connectionController = undefined;
    if (this.options.subscription !== undefined) this.sendClose("armada-inbox");
    for (const subscriptionId of this.pendingQueries.keys())
      this.sendClose(subscriptionId);
    this.rejectPending();
    try {
      this.wire?.close();
    } catch {
      // Continue local shutdown.
    }
    this.wire = undefined;
    this.challenge = undefined;
    this.authPromise = undefined;
    await Promise.allSettled([...this.tasks]);
    this.tasks.clear();
    this.update({
      state: "disconnected",
      reconnectAttempts: 0,
      authenticated: false,
      subscriptionLive: false,
      lastError: undefined,
    });
  }

  private rejectPending(): void {
    for (const pending of this.pendingOk.values()) {
      clearTimeout(pending.timer);
      pending.reject(new RelaySessionError());
    }
    this.pendingOk.clear();
    for (const pending of this.pendingQueries.values()) {
      clearTimeout(pending.timer);
      pending.reject(new RelaySessionError());
    }
    this.pendingQueries.clear();
  }

  private clearStableTimer(): void {
    if (this.stableTimer !== undefined) clearTimeout(this.stableTimer);
    this.stableTimer = undefined;
  }

  private isCurrent(generation: number): boolean {
    return this.active && this.generation === generation;
  }

  private isConnectionCurrent(
    generation: number,
    connectionId: number,
  ): boolean {
    return (
      this.isCurrent(generation) && this.activeConnectionId === connectionId
    );
  }

  private update(changes: Partial<RelaySessionSnapshot>): void {
    const next: RelaySessionSnapshot = {
      ...this.currentSnapshot,
      ...changes,
    };
    if (
      changes.lastError === undefined &&
      Object.hasOwn(changes, "lastError")
    ) {
      const withoutError = { ...next };
      delete withoutError.lastError;
      this.currentSnapshot = withoutError;
    } else {
      this.currentSnapshot = next;
    }
    try {
      this.options.onStatus?.(this.snapshot());
    } catch {
      // Status observers cannot terminate relay lifecycle.
    }
  }

  private track<T>(task: Promise<T>): Promise<T> {
    this.tasks.add(task);
    void task.finally(() => this.tasks.delete(task));
    return task;
  }
}

class AuthRequiredError extends RelaySessionError {}

async function connectWebSocket(
  target: ValidatedRelayTarget,
  handlers: RelayWireHandlers,
  signal: AbortSignal,
  limits: RelaySessionLimits,
): Promise<RelayWire> {
  return new Promise<RelayWire>((resolve, reject) => {
    let settled = false;
    const lookup: LookupFunction = (_hostname, options, callback) => {
      if (options.all === true) {
        callback(null, [{ address: target.address, family: target.family }]);
      } else {
        callback(null, target.address, target.family);
      }
    };
    const socket = new WebSocket(target.url, {
      followRedirects: false,
      handshakeTimeout: limits.websocketHandshakeTimeoutMs,
      maxPayload: limits.rawIngressEnvelopeBytes,
      lookup,
    });
    const abort = () => {
      socket.terminate();
      if (!settled) {
        settled = true;
        reject(new RelaySessionError());
      }
    };
    signal.addEventListener("abort", abort, { once: true });
    socket.on("message", (data) => handlers.onMessage(rawDataToString(data)));
    socket.on("close", () => {
      signal.removeEventListener("abort", abort);
      handlers.onClose();
      if (!settled) {
        settled = true;
        reject(new RelaySessionError());
      }
    });
    socket.on("error", () => {
      handlers.onError();
      if (!settled) {
        settled = true;
        reject(new RelaySessionError());
      }
    });
    socket.on("open", () => {
      if (settled || signal.aborted) return;
      settled = true;
      resolve({
        send(frame) {
          if (socket.readyState !== WebSocket.OPEN)
            throw new RelaySessionError();
          socket.send(frame);
        },
        close() {
          if (
            socket.readyState === WebSocket.OPEN ||
            socket.readyState === WebSocket.CONNECTING
          ) {
            socket.close(1000, "session stopped");
          }
        },
      });
    });
  });
}

function resolveLimits(
  overrides: Partial<RelaySessionLimits> | undefined,
): RelaySessionLimits {
  const defaults: RelaySessionLimits = {
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
  for (const key of Object.keys(defaults) as (keyof RelaySessionLimits)[]) {
    const value = resolved[key];
    if (!Number.isSafeInteger(value) || value < 1 || value > defaults[key]) {
      throw new RelaySessionError();
    }
  }
  return resolved;
}

function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  onTimeout: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      reject(new RelaySessionError());
    }, timeoutMs);
    void operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new RelaySessionError());
      },
    );
  });
}

function hasExactTag(tags: string[][], name: string, value: string): boolean {
  return tags.some(
    (tag) => tag.length === 2 && tag[0] === name && tag[1] === value,
  );
}

function isAuthRequired(message: string): boolean {
  return message.startsWith("auth-required:");
}

function isNostrEvent(value: unknown): value is NostrEvent {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>)["id"] === "string"
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

function clampRandom(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(value, 1)) : 0;
}

function rawDataToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}
