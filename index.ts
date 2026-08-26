import {
  defineChannelPluginEntry,
  type ChannelPlugin,
  type OpenClawPluginApi,
  type PluginRuntime,
} from "openclaw/plugin-sdk/core";
import {
  armadaChannelConfigSchema,
  armadaDmChannelPlugin,
  type ArmadaChannelConfigContract,
} from "./src/channel.js";
import type { ResolvedArmadaAccount } from "./src/account.js";
import { CHANNEL_ID, PLUGIN_ID } from "./src/constants.js";
import { setArmadaRuntime } from "./src/runtime.js";

export {
  createDirectMessage,
  createTypingIndicator,
  Nip17ProtocolError,
  unwrapDirectMessage,
  validateGiftWrapCarrier,
  type AuthenticatedDirectMessage,
  type ArmadaTypingRumor,
  type CreatedDirectMessage,
  type CreatedTypingIndicator,
  type CreateDirectMessageInput,
  type CreateTypingIndicatorInput,
  type CryptoSecurityLimits,
  type DirectMessageRumor,
  type GiftWrappedCopy,
  type Nip17EntropySource,
  type UnwrapDirectMessageInput,
  type ValidateGiftWrapCarrierInput,
} from "./src/nip17.js";
export {
  materializeInboundMedia,
  MediaIngressError,
  parseInboundMedia,
  type EncryptedInboundAttachment,
  type MaterializedInboundMedia,
  type ParsedInboundMedia,
} from "./src/media-ingress.js";
export { SECURITY_LIMITS, type SecurityLimits } from "./src/security-limits.js";

interface ArmadaDmEntry {
  id: string;
  name: string;
  description: string;
  configSchema: ArmadaChannelConfigContract;
  register: (api: OpenClawPluginApi) => void;
  channelPlugin: ChannelPlugin<ResolvedArmadaAccount>;
  setChannelRuntime?: (runtime: PluginRuntime) => void;
}

const baseEntry: ArmadaDmEntry = defineChannelPluginEntry({
  id: PLUGIN_ID,
  name: "Armada DM",
  description: "Private one-to-one Armada direct messages over Nostr NIP-17",
  plugin: armadaDmChannelPlugin,
  configSchema: armadaChannelConfigSchema,
  setRuntime: setArmadaRuntime,
});

function registerWithOwnershipDiagnostic(api: OpenClawPluginApi): void {
  try {
    baseEntry.register(api);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const normalizedMessage = message.toLowerCase();
    if (
      /already|duplicate|registered|owner/u.test(normalizedMessage) &&
      normalizedMessage.includes(CHANNEL_ID)
    ) {
      throw new Error(
        'Channel "nostr" is already owned by another enabled plugin. Disable or remove the existing Nostr channel plugin before enabling "armada-dm"; existing channels.nostr configuration is unchanged.',
        { cause: error },
      );
    }
    throw error;
  }
}

const armadaDmEntry: ArmadaDmEntry = {
  ...baseEntry,
  register: registerWithOwnershipDiagnostic,
};

export default armadaDmEntry;
