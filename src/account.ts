import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { resolveRequiredConfiguredSecretRefInputString } from "openclaw/plugin-sdk/secret-input-runtime";
import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/status-helpers";
import { DEFAULT_ACCOUNT_ID } from "./constants.js";
import {
  ArmadaConfigurationError,
  type ArmadaChannelConfig,
  parseArmadaConfig,
} from "./config-schema.js";
import {
  IdentityResolutionError,
  type BotIdentity,
} from "./identity-contract.js";

export interface ResolvedArmadaAccount {
  accountId: string;
  enabled: boolean;
  configured: boolean;
  name?: string;
  config?: ArmadaChannelConfig;
  configurationError?: string;
}

export type SecretRefResolver = (
  params: Parameters<typeof resolveRequiredConfiguredSecretRefInputString>[0],
) => Promise<string | undefined>;

export function resolveArmadaAccount(config: unknown): ResolvedArmadaAccount {
  try {
    const parsed = parseArmadaConfig(config);
    return {
      accountId: DEFAULT_ACCOUNT_ID,
      enabled: parsed.channel.enabled,
      configured: true,
      name: parsed.channel.name,
      config: parsed.channel,
    };
  } catch {
    return {
      accountId: DEFAULT_ACCOUNT_ID,
      enabled: false,
      configured: false,
      configurationError: "Armada DM configuration is invalid.",
    };
  }
}

export async function resolveBotIdentity(
  config: unknown,
  resolver: SecretRefResolver = resolveRequiredConfiguredSecretRefInputString,
  env: NodeJS.ProcessEnv = process.env,
): Promise<BotIdentity> {
  try {
    const parsed = parseArmadaConfig(config);
    const resolved = await resolver({
      config: config as OpenClawConfig,
      env,
      value: parsed.channel.privateKey,
      path: "channels.nostr.privateKey",
      unresolvedReasonStyle: "generic",
    });
    if (resolved === undefined) {
      throw new IdentityResolutionError();
    }
    const { parseResolvedNsec } = await import("./identity.js");
    return parseResolvedNsec(resolved);
  } catch (error) {
    if (
      error instanceof ArmadaConfigurationError ||
      error instanceof IdentityResolutionError
    ) {
      throw new IdentityResolutionError();
    }
    throw new IdentityResolutionError();
  }
}

export async function buildAccountStatus(
  config: unknown,
  resolver: SecretRefResolver = resolveRequiredConfiguredSecretRefInputString,
  runtime?: ChannelAccountSnapshot,
): Promise<ChannelAccountSnapshot> {
  const account = resolveArmadaAccount(config);
  const base: ChannelAccountSnapshot = {
    accountId: DEFAULT_ACCOUNT_ID,
    enabled: account.enabled,
    configured: account.configured,
    running: false,
    connected: false,
    statusState: account.configured ? "configured" : "unconfigured",
    ...(account.name === undefined ? {} : { name: account.name }),
  };

  if (!account.configured) {
    return {
      ...base,
      lastError:
        account.configurationError ?? "Armada DM configuration is invalid.",
    };
  }

  try {
    const resolvedIdentity = await resolveBotIdentity(config, resolver);
    const identity = {
      publicKey: resolvedIdentity.publicKey,
      npub: resolvedIdentity.npub,
    };
    return {
      ...base,
      ...runtime,
      accountId: DEFAULT_ACCOUNT_ID,
      enabled: account.enabled,
      configured: account.configured,
      publicKey: identity.publicKey,
      bot: identity,
    };
  } catch {
    return {
      ...base,
      configured: false,
      statusState: "error",
      lastError: "Nostr bot identity is unavailable or invalid.",
    };
  }
}
