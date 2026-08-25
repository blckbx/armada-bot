import { SECURITY_LIMITS } from "./security-limits.js";

const HEX_32 = /^[0-9a-f]{64}$/u;
const MILLIS_PER_MINUTE = 60_000;

interface TokenBucket {
  tokens: number;
  updatedAt: number;
}

export interface AuthenticatedIngressRateLimiter {
  consume(senderPublicKey: string): boolean;
}

export interface AuthenticatedIngressRateLimiterOptions {
  readonly nowMilliseconds?: () => number;
  readonly senderRatePerMinute?: number;
  readonly senderBurst?: number;
  readonly globalRatePerMinute?: number;
  readonly globalBurst?: number;
  readonly maximumIdentities?: number;
}

export function createAuthenticatedIngressRateLimiter(
  options: AuthenticatedIngressRateLimiterOptions = {},
): AuthenticatedIngressRateLimiter {
  const nowMilliseconds = options.nowMilliseconds ?? Date.now;
  const senderRate = requirePositive(
    options.senderRatePerMinute ??
      SECURITY_LIMITS.authenticatedSenderRatePerMinute,
  );
  const senderBurst = requirePositive(
    options.senderBurst ?? SECURITY_LIMITS.authenticatedSenderBurst,
  );
  const globalRate = requirePositive(
    options.globalRatePerMinute ??
      SECURITY_LIMITS.authenticatedGlobalRatePerMinute,
  );
  const globalBurst = requirePositive(
    options.globalBurst ?? SECURITY_LIMITS.authenticatedGlobalBurst,
  );
  const maximumIdentities = requirePositive(
    options.maximumIdentities ?? SECURITY_LIMITS.rateLimitIdentities,
  );
  const senders = new Map<string, TokenBucket>();
  const global: TokenBucket = {
    tokens: globalBurst,
    updatedAt: requireTimestamp(nowMilliseconds()),
  };

  return {
    consume(senderPublicKey) {
      if (!HEX_32.test(senderPublicKey)) return false;
      const now = requireTimestamp(nowMilliseconds());
      refill(global, now, globalRate, globalBurst);
      let sender = senders.get(senderPublicKey);
      if (sender === undefined) {
        while (senders.size >= maximumIdentities) {
          const oldest = senders.keys().next().value;
          if (oldest === undefined) break;
          senders.delete(oldest);
        }
        sender = { tokens: senderBurst, updatedAt: now };
        senders.set(senderPublicKey, sender);
      } else {
        senders.delete(senderPublicKey);
        senders.set(senderPublicKey, sender);
      }
      refill(sender, now, senderRate, senderBurst);
      if (global.tokens < 1 || sender.tokens < 1) return false;
      global.tokens -= 1;
      sender.tokens -= 1;
      return true;
    },
  };
}

function refill(
  bucket: TokenBucket,
  now: number,
  ratePerMinute: number,
  burst: number,
): void {
  const elapsed = Math.max(0, now - bucket.updatedAt);
  bucket.tokens = Math.min(
    burst,
    bucket.tokens + (elapsed * ratePerMinute) / MILLIS_PER_MINUTE,
  );
  bucket.updatedAt = Math.max(bucket.updatedAt, now);
}

function requirePositive(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("invalid");
  return value;
}

function requireTimestamp(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new Error("invalid");
  return value;
}
