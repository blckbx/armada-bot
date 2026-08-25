import * as nip19 from "nostr-tools/nip19";
import { getPublicKey } from "nostr-tools/pure";
import { MAX_RESOLVED_NSEC_BYTES } from "./constants.js";
import {
  IdentityResolutionError,
  type BotIdentity,
  type PublicBotIdentity,
} from "./identity-contract.js";

export { IdentityResolutionError } from "./identity-contract.js";
export type { BotIdentity, PublicBotIdentity } from "./identity-contract.js";

export function parseResolvedNsec(value: unknown): BotIdentity {
  try {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      new TextEncoder().encode(value).byteLength > MAX_RESOLVED_NSEC_BYTES ||
      /\s/u.test(value) ||
      !value.startsWith("nsec1")
    ) {
      throw new IdentityResolutionError();
    }

    const decoded = nip19.decode(value);
    if (
      decoded.type !== "nsec" ||
      !(decoded.data instanceof Uint8Array) ||
      decoded.data.length !== 32
    ) {
      throw new IdentityResolutionError();
    }

    const secretKey = Uint8Array.from(decoded.data);
    const publicKey = getPublicKey(secretKey);
    return { secretKey, publicKey, npub: nip19.npubEncode(publicKey) };
  } catch {
    throw new IdentityResolutionError();
  }
}

export function toPublicBotIdentity(identity: BotIdentity): PublicBotIdentity {
  return { publicKey: identity.publicKey, npub: identity.npub };
}
