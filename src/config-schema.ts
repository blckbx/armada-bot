import { isAbsolute } from "node:path";
import * as nip19 from "nostr-tools/nip19";
import { z } from "zod";
import { DEFAULT_DISCOVERY_RELAYS, DEFAULT_INBOX_RELAYS } from "./constants.js";
import { SECURITY_LIMITS } from "./security-limits.js";

const MIN_LOOKBACK_SECONDS = 3600;
const MAX_LOOKBACK_SECONDS = 2_592_000;

export class ArmadaConfigurationError extends Error {
  constructor() {
    super("Invalid Armada DM configuration.");
    this.name = "ArmadaConfigurationError";
  }
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function normalizeRelayUrl(value: string): string {
  let hasControlCharacter = false;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 31 || codePoint === 127) {
      hasControlCharacter = true;
      break;
    }
  }
  if (
    utf8Length(value) > SECURITY_LIMITS.relayUrlBytes ||
    hasControlCharacter
  ) {
    throw new ArmadaConfigurationError();
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ArmadaConfigurationError();
  }

  if (
    (parsed.protocol !== "wss:" && parsed.protocol !== "ws:") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.hash !== "" ||
    parsed.hostname === ""
  ) {
    throw new ArmadaConfigurationError();
  }
  return parsed.toString();
}

export function normalizeNostrPublicKey(value: string): string {
  const candidate = value.startsWith("nostr:")
    ? value.slice("nostr:".length)
    : value;
  if (/^[0-9a-fA-F]{64}$/u.test(candidate)) {
    return candidate.toLowerCase();
  }
  if (!candidate.startsWith("npub1")) {
    throw new ArmadaConfigurationError();
  }

  try {
    const decoded = nip19.decode(candidate);
    if (
      decoded.type !== "npub" ||
      typeof decoded.data !== "string" ||
      !/^[0-9a-f]{64}$/u.test(decoded.data)
    ) {
      throw new ArmadaConfigurationError();
    }
    return decoded.data;
  } catch {
    throw new ArmadaConfigurationError();
  }
}

const RelayListSchema = z
  .array(z.string().min(1))
  .min(1)
  .max(SECURITY_LIMITS.configuredRelays)
  .transform((values) => [...new Set(values.map(normalizeRelayUrl))]);

const AllowFromEntrySchema = z
  .string()
  .transform((value) => normalizeNostrPublicKey(value));

export const SecretReferenceSchema = z
  .object({
    source: z.literal("file"),
    provider: z.literal("nostr"),
    id: z.literal("value"),
  })
  .strict();

export const NostrSecretProviderSchema = z
  .object({
    source: z.literal("file"),
    path: z.string().min(1).max(4_096).refine(isAbsolute),
    mode: z.literal("singleValue"),
  })
  .strict();

export const ArmadaChannelConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    name: z.string().min(1).max(128).default("OpenClaw"),
    privateKey: SecretReferenceSchema,
    relays: RelayListSchema.default([...DEFAULT_INBOX_RELAYS]),
    discoveryRelays: RelayListSchema.default([...DEFAULT_DISCOVERY_RELAYS]),
    publishInbox: z.boolean().default(true),
    allowFallbackDelivery: z.boolean().default(true),
    allowPrivateRelays: z.boolean().default(false),
    dmPolicy: z.literal("allowlist").default("allowlist"),
    allowFrom: z.array(AllowFromEntrySchema).length(1),
    recoveryLookbackSeconds: z
      .number()
      .int()
      .min(MIN_LOOKBACK_SECONDS)
      .max(MAX_LOOKBACK_SECONDS)
      .default(604_800),
    maxFutureSkewSeconds: z.number().int().min(0).max(3600).default(300),
    maxMessageAgeSeconds: z
      .number()
      .int()
      .min(MIN_LOOKBACK_SECONDS)
      .max(MAX_LOOKBACK_SECONDS)
      .default(604_800),
    markdown: z
      .object({
        tables: z.enum(["off", "bullets", "code", "block"]).default("bullets"),
      })
      .strict()
      .default({ tables: "bullets" }),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      !value.allowPrivateRelays &&
      [...value.relays, ...value.discoveryRelays].some((relay) =>
        relay.startsWith("ws:"),
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["allowPrivateRelays"],
        message: "Private or insecure relay URLs require explicit consent.",
      });
    }
    if (value.maxMessageAgeSeconds < value.recoveryLookbackSeconds) {
      context.addIssue({
        code: "custom",
        path: ["maxMessageAgeSeconds"],
        message: "Message age must cover the relay recovery lookback.",
      });
    }
  });

export type ArmadaChannelConfig = z.infer<typeof ArmadaChannelConfigSchema>;
export type NostrSecretProvider = z.infer<typeof NostrSecretProviderSchema>;

export interface ParsedArmadaConfig {
  channel: ArmadaChannelConfig;
  provider: NostrSecretProvider;
}

export function parseChannelConfig(value: unknown): ArmadaChannelConfig {
  try {
    return ArmadaChannelConfigSchema.parse(value);
  } catch {
    throw new ArmadaConfigurationError();
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function parseArmadaConfig(value: unknown): ParsedArmadaConfig {
  try {
    const root = asRecord(value);
    const secrets = asRecord(root?.["secrets"]);
    const providers = asRecord(secrets?.["providers"]);
    const channels = asRecord(root?.["channels"]);
    return {
      channel: ArmadaChannelConfigSchema.parse(channels?.["nostr"]),
      provider: NostrSecretProviderSchema.parse(providers?.["nostr"]),
    };
  } catch {
    throw new ArmadaConfigurationError();
  }
}
