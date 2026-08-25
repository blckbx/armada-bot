import { once } from "node:events";
import { type AddressInfo } from "node:net";
import { verifyEvent, type NostrEvent } from "nostr-tools/pure";
import { WebSocketServer, type RawData, type WebSocket } from "ws";

interface ConnectionState {
  socket: WebSocket;
  authenticated: boolean;
  challenge: string;
  subscriptions: Map<string, Record<string, unknown>>;
}

export interface LoopbackRelayOptions {
  requireAuth?: boolean;
  rejectEvents?: boolean;
}

export class LoopbackRelay {
  readonly requests: {
    subscriptionId: string;
    filter: Record<string, unknown>;
  }[] = [];
  readonly authEvents: NostrEvent[] = [];
  readonly publishedEvents: NostrEvent[] = [];
  readonly closedSubscriptions: string[] = [];
  readonly storedEvents: NostrEvent[] = [];

  private readonly server = new WebSocketServer({
    host: "127.0.0.1",
    port: 0,
  });
  private readonly connections = new Set<ConnectionState>();
  private challengeSequence = 0;
  private urlValue: string | undefined;

  constructor(private readonly options: LoopbackRelayOptions = {}) {}

  get url(): string {
    if (this.urlValue === undefined)
      throw new Error("loopback relay is not started");
    return this.urlValue;
  }

  get connectionCount(): number {
    return this.connections.size;
  }

  async start(): Promise<void> {
    if (!this.server.address()) await once(this.server, "listening");
    const address = this.server.address() as AddressInfo;
    this.urlValue = `ws://127.0.0.1:${String(address.port)}/`;
    this.server.on("connection", (socket) => {
      const state: ConnectionState = {
        socket,
        authenticated: false,
        challenge: this.nextChallenge(),
        subscriptions: new Map(),
      };
      this.connections.add(state);
      socket.on("message", (data) =>
        this.handleFrame(state, rawDataToString(data)),
      );
      socket.on("close", () => this.connections.delete(state));
      if (this.options.requireAuth === true) {
        socket.send(JSON.stringify(["AUTH", state.challenge]));
      }
    });
  }

  async stop(): Promise<void> {
    for (const connection of this.connections) connection.socket.terminate();
    this.connections.clear();
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) =>
        error === undefined ? resolve() : reject(error),
      );
    });
  }

  disconnectAll(): void {
    for (const connection of this.connections) connection.socket.terminate();
  }

  replaceChallenge(challenge: string): void {
    for (const connection of this.connections) {
      connection.challenge = challenge;
      connection.authenticated = false;
      connection.socket.send(JSON.stringify(["AUTH", challenge]));
    }
  }

  sendEvent(event: NostrEvent): void {
    this.storedEvents.push(event);
    for (const connection of this.connections) {
      for (const [subscriptionId, filter] of connection.subscriptions) {
        if (matchesFilter(event, filter)) {
          connection.socket.send(
            JSON.stringify(["EVENT", subscriptionId, event]),
          );
        }
      }
    }
  }

  sendRaw(frame: unknown): void {
    for (const connection of this.connections) {
      connection.socket.send(JSON.stringify(frame));
    }
  }

  private handleFrame(connection: ConnectionState, raw: string): void {
    let frame: unknown;
    try {
      frame = JSON.parse(raw) as unknown;
    } catch {
      return;
    }
    if (!Array.isArray(frame) || typeof frame[0] !== "string") return;

    if (frame[0] === "AUTH") {
      const event: unknown = frame[1];
      if (!isNostrEvent(event)) return;
      this.authEvents.push(event);
      const valid =
        verifyEvent(cloneEvent(event)) &&
        event.kind === 22_242 &&
        hasExactTag(event.tags, "relay", this.url) &&
        hasExactTag(event.tags, "challenge", connection.challenge);
      connection.authenticated = valid;
      connection.socket.send(
        JSON.stringify(["OK", event.id, valid, valid ? "" : "restricted"]),
      );
      return;
    }

    if (frame[0] === "REQ") {
      const subscriptionId: unknown = frame[1];
      const filter: unknown = frame[2];
      if (typeof subscriptionId !== "string" || !isRecord(filter)) return;
      this.requests.push({ subscriptionId, filter });
      if (this.options.requireAuth === true && !connection.authenticated) {
        connection.socket.send(
          JSON.stringify([
            "CLOSED",
            subscriptionId,
            "auth-required: authenticate",
          ]),
        );
        return;
      }
      connection.subscriptions.set(subscriptionId, filter);
      for (const event of this.storedEvents) {
        if (matchesFilter(event, filter)) {
          connection.socket.send(
            JSON.stringify(["EVENT", subscriptionId, event]),
          );
        }
      }
      connection.socket.send(JSON.stringify(["EOSE", subscriptionId]));
      return;
    }

    if (frame[0] === "CLOSE" && typeof frame[1] === "string") {
      this.closedSubscriptions.push(frame[1]);
      connection.subscriptions.delete(frame[1]);
      return;
    }

    if (frame[0] === "EVENT" && isNostrEvent(frame[1])) {
      const event = frame[1];
      if (this.options.requireAuth === true && !connection.authenticated) {
        connection.socket.send(
          JSON.stringify([
            "OK",
            event.id,
            false,
            "auth-required: authenticate",
          ]),
        );
        return;
      }
      const accepted =
        this.options.rejectEvents !== true && verifyEvent(cloneEvent(event));
      if (accepted) {
        this.publishedEvents.push(event);
        this.storedEvents.push(event);
      }
      connection.socket.send(
        JSON.stringify([
          "OK",
          event.id,
          accepted,
          accepted ? "" : "restricted",
        ]),
      );
    }
  }

  private nextChallenge(): string {
    this.challengeSequence += 1;
    return `loopback-challenge-${String(this.challengeSequence)}`;
  }
}

function matchesFilter(
  event: NostrEvent,
  filter: Record<string, unknown>,
): boolean {
  const kinds = filter["kinds"];
  if (Array.isArray(kinds) && !kinds.includes(event.kind)) return false;
  const authors = filter["authors"];
  if (Array.isArray(authors) && !authors.includes(event.pubkey)) return false;
  const recipients = filter["#p"];
  if (
    Array.isArray(recipients) &&
    !event.tags.some((tag) => tag[0] === "p" && recipients.includes(tag[1]))
  ) {
    return false;
  }
  const since = filter["since"];
  if (typeof since === "number" && event.created_at < since) return false;
  return true;
}

function hasExactTag(tags: string[][], name: string, value: string): boolean {
  return tags.some(
    (tag) => tag.length === 2 && tag[0] === name && tag[1] === value,
  );
}

function isNostrEvent(value: unknown): value is NostrEvent {
  return (
    isRecord(value) &&
    typeof value["kind"] === "number" &&
    Array.isArray(value["tags"]) &&
    typeof value["content"] === "string" &&
    typeof value["created_at"] === "number" &&
    typeof value["pubkey"] === "string" &&
    typeof value["id"] === "string" &&
    typeof value["sig"] === "string"
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rawDataToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}
