import type { ChannelPlugin } from "openclaw/plugin-sdk/core";
import type { NostrEvent } from "nostr-tools/pure";
import { resolveBotIdentity, type ResolvedArmadaAccount } from "./account.js";
import { createInboundProcessor, type InboundProcessor } from "./inbound.js";
import {
  RelayManager,
  type RelayManagerOptions,
  type RelayPublicationOptions,
  type RelayManagerSnapshot,
} from "./relay-manager.js";
import { RecipientRelayRouter } from "./relay-routing.js";
import { ClaimableReplayGate } from "./replay-gate.js";
import { getArmadaRuntime } from "./runtime.js";

export interface RelayManagerLike {
  start(): Promise<void>;
  stop(): Promise<void>;
  snapshot(): RelayManagerSnapshot;
  publishToAtLeastOne?(
    relayUrls: string[],
    event: NostrEvent,
    options?: RelayPublicationOptions,
  ): Promise<unknown>;
  queryRelays?(
    relayUrls: string[],
    filter: Record<string, unknown>,
  ): Promise<NostrEvent[]>;
  markIntakeDegraded?(): void;
  markInboundRateLimited?(): void;
}

export interface ArmadaGatewayDependencies {
  readonly resolveIdentity?: typeof resolveBotIdentity;
  readonly createManager?: (options: RelayManagerOptions) => RelayManagerLike;
  readonly createInbound?: typeof createInboundProcessor;
}

type ArmadaGatewayAdapter = NonNullable<
  ChannelPlugin<ResolvedArmadaAccount>["gateway"]
>;

interface ActiveRelayManager {
  readonly manager: RelayManagerLike;
  readonly requestStop: () => void;
}

const activeManagers = new Map<string, ActiveRelayManager>();

export function createArmadaGatewayAdapter(
  dependencies: ArmadaGatewayDependencies = {},
): ArmadaGatewayAdapter {
  const resolveIdentity = dependencies.resolveIdentity ?? resolveBotIdentity;
  const createManager =
    dependencies.createManager ??
    ((options: RelayManagerOptions) => new RelayManager(options));
  const createInbound = dependencies.createInbound ?? createInboundProcessor;

  return {
    async startAccount(context) {
      const account = context.account;
      if (
        !account.enabled ||
        !account.configured ||
        account.config === undefined
      )
        return;
      const config = account.config;

      const identity = await resolveIdentity(context.cfg);
      const project = (snapshot: RelayManagerSnapshot) => {
        const next = {
          ...context.getStatus(),
          accountId: account.accountId,
          enabled: true,
          configured: true,
          running: snapshot.running,
          connected: snapshot.liveSubscriptions > 0,
          statusState: snapshot.running
            ? snapshot.ready
              ? "ready"
              : "degraded"
            : "stopped",
          healthState: snapshot.health,
          reconnectAttempts: snapshot.relays.reduce(
            (total, relay) => total + relay.reconnectAttempts,
            0,
          ),
          publicKey: identity.publicKey,
          bot: { publicKey: identity.publicKey, npub: identity.npub },
          probe: snapshot,
          ...(snapshot.lastError === undefined
            ? {}
            : { lastError: snapshot.lastError }),
        };
        context.setStatus(next);
      };
      const managerHolder: { value?: RelayManagerLike } = {};
      let inbound: InboundProcessor | undefined;
      const handleInbound = (event: NostrEvent): Promise<void> => {
        const activeManager = managerHolder.value;
        if (activeManager === undefined) return Promise.resolve();
        if (inbound === undefined) {
          if (
            activeManager.queryRelays === undefined ||
            activeManager.publishToAtLeastOne === undefined
          ) {
            return Promise.reject(new Error("Relay transport is incomplete."));
          }
          const router = new RecipientRelayRouter({
            discoveryRelays: config.discoveryRelays,
            fallbackRelays: config.relays,
            allowFallbackDelivery: config.allowFallbackDelivery,
            maxFutureSkewSeconds: config.maxFutureSkewSeconds,
            query: (relayUrls, filter) =>
              activeManager.queryRelays?.(relayUrls, filter) ??
              Promise.resolve([]),
          });
          const replayGate = new ClaimableReplayGate({
            accountId: account.accountId,
            botPublicKey: identity.publicKey,
            maxMessageAgeSeconds: config.maxMessageAgeSeconds,
            onDegraded: () => activeManager.markIntakeDegraded?.(),
          });
          inbound = createInbound({
            cfg: context.cfg,
            runtime: getArmadaRuntime(),
            accountId: account.accountId,
            config,
            identity,
            replayGate,
            resolveRecipientRelays: (recipientPublicKey) =>
              router.resolve(recipientPublicKey),
            publishRecipient: (relayUrls, reply) =>
              activeManager.publishToAtLeastOne?.(relayUrls, reply, {
                source: "recipient",
              }) ?? Promise.reject(new Error("Relay transport stopped.")),
            publishSelfCopy: (reply) =>
              activeManager.publishToAtLeastOne?.(config.relays, reply, {
                source: "configured",
              }) ?? Promise.reject(new Error("Relay transport stopped.")),
          });
        }
        return inbound.handle(event, context.abortSignal).then((result) => {
          if (result.rateLimited) activeManager.markInboundRateLimited?.();
        });
      };
      const manager = createManager({
        inboxRelays: config.relays,
        discoveryRelays: config.discoveryRelays,
        publishInbox: config.publishInbox,
        allowPrivateRelays: config.allowPrivateRelays,
        identity,
        recoveryLookbackSeconds: config.recoveryLookbackSeconds,
        maxMessageAgeSeconds: config.maxMessageAgeSeconds,
        maxFutureSkewSeconds: config.maxFutureSkewSeconds,
        onEvent: handleInbound,
        onStatus: project,
      });
      managerHolder.value = manager;
      let requestLocalStop: (() => void) | undefined;
      const localStop = new Promise<void>((resolve) => {
        requestLocalStop = resolve;
      });

      activeManagers.set(account.accountId, {
        manager,
        requestStop: () => requestLocalStop?.(),
      });
      try {
        await manager.start();
        project(manager.snapshot());
        await Promise.race([waitForAbort(context.abortSignal), localStop]);
      } finally {
        await manager.stop();
        if (activeManagers.get(account.accountId)?.manager === manager) {
          activeManagers.delete(account.accountId);
        }
        project(manager.snapshot());
      }
    },
    async stopAccount(context) {
      const active = activeManagers.get(context.accountId);
      active?.requestStop();
      await active?.manager.stop();
    },
  };
}

export function getActiveRelaySnapshot(
  accountId: string,
): RelayManagerSnapshot | undefined {
  return activeManagers.get(accountId)?.manager.snapshot();
}

export const armadaGatewayAdapter: ArmadaGatewayAdapter =
  createArmadaGatewayAdapter();

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true }),
  );
}
