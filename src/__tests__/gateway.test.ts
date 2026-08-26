import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/core";
import { describe, expect, it, vi } from "vitest";
import { resolveArmadaAccount } from "../account.js";
import {
  createArmadaGatewayAdapter,
  type RelayManagerLike,
} from "../gateway.js";
import type {
  RelayManagerOptions,
  RelayManagerSnapshot,
} from "../relay-manager.js";
import { setArmadaRuntime } from "../runtime.js";
import { BOT_PUBLIC_KEY, BOT_SECRET_KEY } from "./nip17-fixtures.js";
import { createArmadaFixture } from "./nip17-fixtures.js";
import { validConfig } from "./helpers.js";

const INITIAL_SNAPSHOT: RelayManagerSnapshot = {
  running: false,
  ready: false,
  health: "stopped",
  announcementVerified: false,
  configuredInboxRelays: 0,
  connectedInboxRelays: 0,
  liveSubscriptions: 0,
  partiallyAvailable: false,
  dedupeAvailable: true,
  queuedInboundEvents: 0,
  activeInboundHandlers: 0,
  droppedInboundEvents: 0,
  rateLimitedInboundEvents: 0,
  failedInboundEvents: 0,
  relays: [],
};

describe("Slice 3 gateway lifecycle", () => {
  it("starts an enabled account, projects reachability status, and stops on abort", async () => {
    const cfg = validConfig();
    const account = resolveArmadaAccount(cfg);
    const abort = new AbortController();
    const statuses: ChannelAccountSnapshot[] = [];
    let managerOptions: RelayManagerOptions | undefined;
    let snapshot = INITIAL_SNAPSHOT;
    const startManager = vi.fn(() => {
      snapshot = {
        ...INITIAL_SNAPSHOT,
        running: true,
        ready: true,
        health: "healthy",
        announcementVerified: true,
        liveSubscriptions: 2,
        relays: [
          {
            relayUrl: "wss://relay.ditto.pub/",
            state: "connected",
            reconnectAttempts: 0,
            authenticated: true,
            subscriptionLive: true,
          },
        ],
      };
      managerOptions?.onStatus?.(snapshot);
      return Promise.resolve();
    });
    const stopManager = vi.fn(() => {
      snapshot = INITIAL_SNAPSHOT;
      managerOptions?.onStatus?.(snapshot);
      return Promise.resolve();
    });
    const manager: RelayManagerLike = {
      start: startManager,
      stop: stopManager,
      snapshot: () => snapshot,
    };
    const adapter = createArmadaGatewayAdapter({
      resolveIdentity: () =>
        Promise.resolve({
          secretKey: BOT_SECRET_KEY,
          publicKey: BOT_PUBLIC_KEY,
          npub: "npub-test",
        }),
      createManager: (options) => {
        managerOptions = options;
        return manager;
      },
    });

    const running = adapter.startAccount?.({
      cfg,
      accountId: account.accountId,
      account,
      runtime: {} as never,
      abortSignal: abort.signal,
      getStatus: () => ({ accountId: account.accountId }),
      setStatus: (status) => statuses.push(status),
    });
    await eventually(() => startManager.mock.calls.length === 1);

    expect(managerOptions).toMatchObject({
      inboxRelays: [
        "wss://relay.armada.buzz/",
        "wss://relay.ditto.pub/",
        "wss://relay.dreamith.to/",
      ],
      discoveryRelays: ["wss://relay.ditto.pub/", "wss://relay.dreamith.to/"],
      publishInbox: true,
      identity: { publicKey: BOT_PUBLIC_KEY },
    });
    const readyStatus = statuses.at(-1);
    expect(readyStatus).toMatchObject({
      accountId: "default",
      running: true,
      connected: true,
      statusState: "ready",
      healthState: "healthy",
      publicKey: BOT_PUBLIC_KEY,
    });
    expect(
      (readyStatus?.probe as RelayManagerSnapshot | undefined)
        ?.liveSubscriptions,
    ).toBe(2);

    abort.abort();
    await running;
    expect(stopManager).toHaveBeenCalledOnce();
    expect(statuses.at(-1)).toMatchObject({
      running: false,
      connected: false,
      statusState: "stopped",
    });
  });

  it("does not resolve identity or create transport for a disabled account", async () => {
    const cfg = validConfig();
    (
      (cfg["channels"] as Record<string, unknown>)["nostr"] as Record<
        string,
        unknown
      >
    )["enabled"] = false;
    const account = resolveArmadaAccount(cfg);
    const resolveIdentity = vi.fn(() =>
      Promise.reject(new Error("not called")),
    );
    const createManager = vi.fn((): RelayManagerLike => {
      throw new Error("not called");
    });
    const adapter = createArmadaGatewayAdapter({
      resolveIdentity,
      createManager,
    });

    await adapter.startAccount?.({
      cfg,
      accountId: account.accountId,
      account,
      runtime: {} as never,
      abortSignal: new AbortController().signal,
      getStatus: () => ({ accountId: account.accountId }),
      setStatus: () => undefined,
    });

    expect(resolveIdentity).not.toHaveBeenCalled();
    expect(createManager).not.toHaveBeenCalled();
  });

  it("projects authenticated rate-limit rejections into sanitized status", async () => {
    setArmadaRuntime({} as never);
    const cfg = validConfig();
    const account = resolveArmadaAccount(cfg);
    const abort = new AbortController();
    const markInboundRateLimited = vi.fn();
    let managerOptions: RelayManagerOptions | undefined;
    const manager: RelayManagerLike = {
      start: async () => {
        await managerOptions?.onEvent(createArmadaFixture());
        abort.abort();
      },
      stop: () => Promise.resolve(),
      snapshot: () => INITIAL_SNAPSHOT,
      queryRelays: () => Promise.resolve([]),
      publishToAtLeastOne: () => Promise.resolve(undefined),
      markInboundRateLimited,
    };
    const adapter = createArmadaGatewayAdapter({
      resolveIdentity: () =>
        Promise.resolve({
          secretKey: BOT_SECRET_KEY,
          publicKey: BOT_PUBLIC_KEY,
          npub: "npub-test",
        }),
      createManager: (options) => {
        managerOptions = options;
        return manager;
      },
      createInbound: () => ({
        handle: () =>
          Promise.resolve({ handled: false, rateLimited: true as const }),
      }),
    });

    await adapter.startAccount?.({
      cfg,
      accountId: account.accountId,
      account,
      runtime: {} as never,
      abortSignal: abort.signal,
      getStatus: () => ({ accountId: account.accountId }),
      setStatus: () => undefined,
    });

    expect(markInboundRateLimited).toHaveBeenCalledOnce();
  });
});

async function eventually(
  predicate: () => boolean,
  attempts = 100,
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition was not met");
}
