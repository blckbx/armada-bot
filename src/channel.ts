import {
  buildJsonChannelConfigSchema,
  type ChannelPlugin,
} from "openclaw/plugin-sdk/core";
import {
  buildAccountStatus,
  resolveArmadaAccount,
  type ResolvedArmadaAccount,
} from "./account.js";
import { CHANNEL_ID, DEFAULT_ACCOUNT_ID } from "./constants.js";
import { ARMADA_CHANNEL_JSON_SCHEMA } from "./config-json-schema.js";
import { ArmadaChannelConfigSchema } from "./config-schema.js";
import { armadaGatewayAdapter } from "./gateway.js";

export type ArmadaChannelConfigContract = ReturnType<
  typeof buildJsonChannelConfigSchema
>;

export const armadaChannelConfigSchema: ArmadaChannelConfigContract =
  buildJsonChannelConfigSchema(ARMADA_CHANNEL_JSON_SCHEMA, {
    runtime: {
      safeParse(value) {
        const result = ArmadaChannelConfigSchema.safeParse(value);
        if (result.success) {
          return { success: true, data: result.data };
        }
        return {
          success: false,
          issues: result.error.issues.map((issue) => ({
            path: issue.path.filter(
              (part): part is string | number =>
                typeof part === "string" || typeof part === "number",
            ),
            message: issue.message,
            code: issue.code,
          })),
        };
      },
    },
  });

export const armadaDmChannelPlugin: ChannelPlugin<ResolvedArmadaAccount> = {
  id: CHANNEL_ID,
  meta: {
    id: CHANNEL_ID,
    label: "Armada DM",
    selectionLabel: "Armada DM (Nostr NIP-17)",
    detailLabel: "Nostr private direct messages",
    docsPath: "/channels/nostr",
    docsLabel: "Armada DM",
    blurb: "Private one-to-one Armada messages over NIP-17.",
    markdownCapable: true,
  },
  capabilities: {
    chatTypes: ["direct"],
    polls: false,
    reactions: false,
    edit: false,
    unsend: false,
    reply: true,
    groupManagement: false,
    threads: false,
    media: false,
    nativeCommands: false,
  },
  reload: { configPrefixes: ["channels.nostr"] },
  configSchema: armadaChannelConfigSchema,
  config: {
    listAccountIds: () => [DEFAULT_ACCOUNT_ID],
    defaultAccountId: () => DEFAULT_ACCOUNT_ID,
    resolveAccount: (cfg) => resolveArmadaAccount(cfg),
    isEnabled: (account) => account.enabled,
    isConfigured: (account) => account.configured,
    disabledReason: () => "Armada DM is disabled.",
    unconfiguredReason: (account) =>
      account.configurationError ??
      "Armada DM requires its file-backed Nostr identity.",
    describeAccount: (account) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: account.configured,
      ...(account.name === undefined ? {} : { name: account.name }),
    }),
    hasConfiguredState: ({ cfg }) => resolveArmadaAccount(cfg).configured,
  },
  gateway: armadaGatewayAdapter,
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      enabled: false,
      configured: false,
      running: false,
      connected: false,
    },
    buildAccountSnapshot: async ({ cfg, runtime }) =>
      buildAccountStatus(cfg, undefined, runtime),
  },
};
