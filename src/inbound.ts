import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk/core";
import { dispatchInboundDirectDmWithRuntime } from "openclaw/plugin-sdk/direct-dm";
import {
  resolveStableChannelMessageIngress,
  type ResolvedChannelMessageIngress,
} from "openclaw/plugin-sdk/channel-ingress-runtime";
import {
  buildChannelInboundMediaPayload,
  toInboundMediaFacts,
} from "openclaw/plugin-sdk/channel-inbound";
import type { NostrEvent } from "nostr-tools/pure";
import {
  materializeInboundMedia,
  parseInboundMedia,
  type MaterializedInboundMedia,
} from "./media-ingress.js";
import {
  createDirectMessage,
  createTypingIndicator,
  unwrapDirectMessage,
  type CreatedDirectMessage,
  type CreatedTypingIndicator,
  type CreateDirectMessageInput,
  type CreateTypingIndicatorInput,
  type DirectMessageRumor,
} from "./nip17.js";
import {
  createAuthenticatedIngressRateLimiter,
  type AuthenticatedIngressRateLimiter,
} from "./rate-limit.js";
import type { ReplayGate } from "./replay-gate.js";

const HEX_32 = /^[0-9a-f]{64}$/u;
export const ARMADA_TYPING_REFRESH_MILLISECONDS = 4_000;

export class InboundDispatchError extends Error {
  constructor(message = "Inbound direct message dispatch failed.") {
    super(message);
    this.name = "InboundDispatchError";
  }
}

export class DirectMessageDeliveryError extends Error {
  constructor() {
    super("Direct message delivery failed.");
    this.name = "DirectMessageDeliveryError";
  }
}

export const RECOVERY_COPY_WARNING =
  "Sender recovery copy delivery failed." as const;

export interface InboundProcessorConfig {
  readonly dmPolicy: "allowlist";
  readonly allowFrom: string[];
  readonly maxMessageAgeSeconds: number;
  readonly maxFutureSkewSeconds: number;
}

type IngressResolver = typeof resolveStableChannelMessageIngress;
type DirectDmDispatcher = typeof dispatchInboundDirectDmWithRuntime;

export interface InboundProcessorOptions {
  readonly cfg: OpenClawConfig;
  readonly runtime: PluginRuntime;
  readonly accountId: string;
  readonly config: InboundProcessorConfig;
  readonly identity: {
    readonly secretKey: Uint8Array;
    readonly publicKey: string;
  };
  readonly replayGate: ReplayGate;
  readonly resolveRecipientRelays: (
    recipientPublicKey: string,
  ) => Promise<string[]>;
  readonly publishRecipient: (
    relayUrls: string[],
    event: NostrEvent,
  ) => Promise<unknown>;
  readonly publishSelfCopy: (event: NostrEvent) => Promise<unknown>;
  readonly resolveIngress?: IngressResolver;
  readonly dispatch?: DirectDmDispatcher;
  readonly createReply?: (
    input: CreateDirectMessageInput,
  ) => CreatedDirectMessage;
  readonly createTyping?: (
    input: CreateTypingIndicatorInput,
  ) => CreatedTypingIndicator;
  readonly prepareMedia?: (
    rumor: DirectMessageRumor,
    signal?: AbortSignal,
  ) => Promise<MaterializedInboundMedia>;
  readonly nowSeconds?: () => number;
  readonly nowMilliseconds?: () => number;
  readonly rateLimiter?: AuthenticatedIngressRateLimiter;
}

export interface InboundHandleResult {
  readonly handled: boolean;
  readonly messageIds?: string[];
  readonly warnings?: string[];
  readonly rateLimited?: boolean;
}

export interface InboundProcessor {
  handle(wrap: NostrEvent, signal?: AbortSignal): Promise<InboundHandleResult>;
}

export function createInboundProcessor(
  options: InboundProcessorOptions,
): InboundProcessor {
  const resolveIngress =
    options.resolveIngress ?? resolveStableChannelMessageIngress;
  const dispatch = options.dispatch ?? dispatchInboundDirectDmWithRuntime;
  const createReply = options.createReply ?? createDirectMessage;
  const createTyping = options.createTyping ?? createTypingIndicator;
  const prepareMedia =
    options.prepareMedia ??
    (async (rumor: DirectMessageRumor, signal?: AbortSignal) =>
      materializeInboundMedia({
        parsed: parseInboundMedia(rumor),
        ...(signal === undefined ? {} : { signal }),
      }));
  const nowSeconds =
    options.nowSeconds ?? (() => Math.floor(Date.now() / 1_000));
  const rateLimiter =
    options.rateLimiter ??
    createAuthenticatedIngressRateLimiter({
      ...(options.nowMilliseconds === undefined
        ? {}
        : { nowMilliseconds: options.nowMilliseconds }),
    });

  return {
    async handle(wrap, signal) {
      if (isAborted(signal) || options.replayGate.degraded) {
        return { handled: false };
      }
      const authenticated = unwrapDirectMessage({
        wrap,
        recipientSecretKey: options.identity.secretKey,
        recipientPublicKey: options.identity.publicKey,
        now: nowSeconds(),
        maxMessageAgeSeconds: options.config.maxMessageAgeSeconds,
        maxFutureSkewSeconds: options.config.maxFutureSkewSeconds,
      });
      if (isAborted(signal)) return { handled: false };
      if (authenticated.direction === "self-copy") {
        return { handled: false };
      }
      const claim = await options.replayGate.claim(authenticated.rumorId);
      if (claim === null) return { handled: false };
      if (isAborted(signal)) {
        claim.release();
        return { handled: false };
      }

      try {
        const senderPublicKey = authenticated.senderPublicKey;
        const senderAddress = `nostr:${senderPublicKey}`;
        const command = shouldComputeCommand(
          options.runtime,
          authenticated.content,
          options.cfg,
        )
          ? ({ modeWhenAccessGroupsOff: "configured" } as const)
          : false;
        const ingress: ResolvedChannelMessageIngress = await resolveIngress({
          channelId: "nostr",
          accountId: options.accountId,
          identity: {
            key: "nostr-pubkey",
            normalize: normalizeIdentity,
            isWildcardEntry: (value) => value === "*",
            sensitivity: "pii",
            entryIdPrefix: "nostr-entry",
          },
          cfg: options.cfg,
          useDefaultPairingStore: false,
          subject: { stableId: senderPublicKey },
          conversation: { kind: "direct", id: senderPublicKey },
          dmPolicy: options.config.dmPolicy,
          allowFrom: options.config.allowFrom,
          command,
        });
        if (ingress.senderAccess.decision !== "allow") {
          claim.release();
          return { handled: false };
        }
        if (isAborted(signal)) {
          claim.release();
          return { handled: false };
        }
        if (!rateLimiter.consume(senderPublicKey)) {
          // This authenticated logical message was intentionally consumed.
          // Committing prevents relay copies from retrying the same burst.
          await claim.commit();
          return { handled: false, rateLimited: true };
        }

        const deliveredMessageIds: string[] = [];
        const warnings = new Set<string>();
        const callbackState = { failed: false };
        const resolveTurnRecipientRelays = createTurnRelayResolver(() =>
          options.resolveRecipientRelays(senderPublicKey),
        );
        const stopTyping = startTypingHeartbeat({
          senderSecretKey: options.identity.secretKey,
          recipientPublicKey: senderPublicKey,
          resolveRecipientRelays: resolveTurnRecipientRelays,
          publishRecipient: options.publishRecipient,
          createTyping,
          nowSeconds,
          signal,
        });
        try {
          const preparedMedia = await prepareMedia(authenticated.rumor, signal);
          if (isAborted(signal)) {
            claim.release();
            return { handled: false };
          }
          const mediaContext = buildChannelInboundMediaPayload(
            toInboundMediaFacts(preparedMedia.media),
          );
          await dispatch({
            cfg: withAutomaticVisibleReplies(options.cfg),
            runtime: options.runtime,
            channel: "nostr",
            channelLabel: "Armada DM",
            accountId: options.accountId,
            peer: { kind: "direct", id: senderPublicKey },
            senderId: senderPublicKey,
            senderAddress,
            recipientAddress: `nostr:${options.identity.publicKey}`,
            conversationLabel: senderPublicKey,
            rawBody: preparedMedia.body,
            bodyForAgent: preparedMedia.body,
            commandBody: preparedMedia.body,
            messageId: authenticated.rumorId,
            timestamp: authenticated.createdAt * 1_000,
            ...(ingress.commandAccess.requested
              ? { commandAuthorized: ingress.commandAccess.authorized }
              : {}),
            ...(preparedMedia.media.length === 0
              ? {}
              : { extraContext: mediaContext }),
            deliver: async (payload) => {
              if (isAborted(signal)) return;
              const text = formatOutboundText(
                options.runtime,
                options.cfg,
                options.accountId,
                extractText(payload),
              );
              if (text.trim() === "" || isAborted(signal)) return;
              let relayUrls: string[];
              try {
                relayUrls = await resolveTurnRecipientRelays();
              } catch {
                // A transient lookup used by typing must not poison the reply.
                try {
                  relayUrls = await resolveTurnRecipientRelays();
                } catch {
                  throw new DirectMessageDeliveryError();
                }
              }
              if (isAborted(signal)) return;
              if (relayUrls.length === 0)
                throw new DirectMessageDeliveryError();
              let reply: CreatedDirectMessage;
              try {
                reply = createReply({
                  senderSecretKey: options.identity.secretKey,
                  recipientPublicKey: senderPublicKey,
                  content: text,
                  replyToEventId: authenticated.rumorId,
                  now: nowSeconds(),
                });
              } catch {
                throw new DirectMessageDeliveryError();
              }
              if (isAborted(signal)) return;
              try {
                await options.publishRecipient(relayUrls, reply.recipient.wrap);
              } catch {
                throw new DirectMessageDeliveryError();
              }
              deliveredMessageIds.push(reply.logicalMessageId);
              if (isAborted(signal)) return;
              try {
                await options.publishSelfCopy(reply.selfCopy.wrap);
              } catch {
                warnings.add(RECOVERY_COPY_WARNING);
              }
            },
            onRecordError: () => {
              callbackState.failed = true;
            },
            onDispatchError: () => {
              callbackState.failed = true;
            },
          });
          if (callbackState.failed) throw new InboundDispatchError();
          if (isAborted(signal)) {
            if (deliveredMessageIds.length > 0) await claim.commit();
            else claim.release();
            return { handled: false };
          }
          await claim.commit();
          return {
            handled: true,
            ...(deliveredMessageIds.length === 0
              ? {}
              : { messageIds: deliveredMessageIds }),
            ...(warnings.size === 0 ? {} : { warnings: [...warnings] }),
          };
        } finally {
          stopTyping();
        }
      } catch (error) {
        claim.release(error);
        if (error instanceof DirectMessageDeliveryError) throw error;
        throw new InboundDispatchError();
      }
    },
  };
}

function startTypingHeartbeat(input: {
  senderSecretKey: Uint8Array;
  recipientPublicKey: string;
  resolveRecipientRelays: () => Promise<string[]>;
  publishRecipient: (
    relayUrls: string[],
    event: NostrEvent,
  ) => Promise<unknown>;
  createTyping: (input: CreateTypingIndicatorInput) => CreatedTypingIndicator;
  nowSeconds: () => number;
  signal: AbortSignal | undefined;
}): () => void {
  let stopped = input.signal?.aborted ?? false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const stop = (): void => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    input.signal?.removeEventListener("abort", stop);
  };
  const pulse = async (): Promise<void> => {
    try {
      const relayUrls = await input.resolveRecipientRelays();
      if (stopped || relayUrls.length === 0) return;
      const indicator = input.createTyping({
        senderSecretKey: input.senderSecretKey,
        recipientPublicKey: input.recipientPublicKey,
        now: input.nowSeconds(),
      });
      await input.publishRecipient(relayUrls, indicator.wrap);
    } catch {
      // Typing is transient UX metadata and must never fail the admitted turn.
    } finally {
      if (!stopped) {
        timer = setTimeout(() => {
          void pulse();
        }, ARMADA_TYPING_REFRESH_MILLISECONDS);
      }
    }
  };

  if (!stopped) {
    input.signal?.addEventListener("abort", stop, { once: true });
    void pulse();
  }
  return stop;
}

function createTurnRelayResolver(
  resolve: () => Promise<string[]>,
): () => Promise<string[]> {
  let cached: string[] | undefined;
  let pending: Promise<string[]> | undefined;

  return () => {
    if (cached !== undefined) return Promise.resolve(cached);
    if (pending !== undefined) return pending;
    const lookup = resolve().then((relayUrls) => {
      cached = relayUrls;
      return relayUrls;
    });
    const tracked = lookup.finally(() => {
      if (pending === tracked) pending = undefined;
    });
    pending = tracked;
    return tracked;
  };
}

function withAutomaticVisibleReplies(cfg: OpenClawConfig): OpenClawConfig {
  // Armada owns delivery for this admitted inbound turn. Keep the reply on its
  // conversation-bound NIP-17 callback instead of a shared message-tool path.
  return {
    ...cfg,
    messages: {
      ...cfg.messages,
      visibleReplies: "automatic",
    },
  };
}

function normalizeIdentity(value: string): string | null {
  const candidate = value.startsWith("nostr:")
    ? value.slice("nostr:".length)
    : value;
  return HEX_32.test(candidate.toLowerCase()) ? candidate.toLowerCase() : null;
}

function shouldComputeCommand(
  runtime: PluginRuntime,
  content: string,
  cfg: OpenClawConfig,
): boolean {
  try {
    return runtime.channel.commands.shouldComputeCommandAuthorized(
      content,
      cfg,
    );
  } catch {
    return false;
  }
}

function extractText(payload: unknown): string {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("text" in payload) ||
    typeof payload.text !== "string"
  ) {
    return "";
  }
  return payload.text;
}

function formatOutboundText(
  runtime: PluginRuntime,
  cfg: OpenClawConfig,
  accountId: string,
  text: string,
): string {
  try {
    const tableMode = runtime.channel.text.resolveMarkdownTableMode({
      cfg,
      channel: "nostr",
      accountId,
    });
    return runtime.channel.text.convertMarkdownTables(text, tableMode);
  } catch {
    return text;
  }
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted ?? false;
}
