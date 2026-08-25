export interface BotIdentity {
  secretKey: Uint8Array;
  publicKey: string;
  npub: string;
}

export type PublicBotIdentity = Omit<BotIdentity, "secretKey">;

export class IdentityResolutionError extends Error {
  constructor() {
    super("Nostr bot identity is unavailable or invalid.");
    this.name = "IdentityResolutionError";
  }
}
