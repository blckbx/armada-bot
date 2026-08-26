export const PLUGIN_ID = "armada-dm";
export const CHANNEL_ID = "nostr";
export const DEFAULT_ACCOUNT_ID = "default";
export const OPENCLAW_BASELINE_VERSION = "2026.6.1";

export const DEFAULT_INBOX_RELAYS = [
  "wss://relay.armada.buzz/",
  "wss://relay.ditto.pub/",
  "wss://relay.dreamith.to/",
] as const;

export const DEFAULT_DISCOVERY_RELAYS = [
  "wss://relay.ditto.pub/",
  "wss://relay.dreamith.to/",
] as const;

export const MAX_RESOLVED_NSEC_BYTES = 256;
