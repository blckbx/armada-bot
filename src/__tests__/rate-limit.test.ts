import { describe, expect, it } from "vitest";
import { createAuthenticatedIngressRateLimiter } from "../rate-limit.js";

const SENDER_A = "a".repeat(64);
const SENDER_B = "b".repeat(64);
const SENDER_C = "c".repeat(64);

describe("authenticated ingress rate limiter", () => {
  it("enforces and refills each sender bucket", () => {
    let now = 1_000;
    const limiter = createAuthenticatedIngressRateLimiter({
      nowMilliseconds: () => now,
      senderRatePerMinute: 60,
      senderBurst: 2,
      globalRatePerMinute: 600,
      globalBurst: 10,
    });

    expect(limiter.consume(SENDER_A)).toBe(true);
    expect(limiter.consume(SENDER_A)).toBe(true);
    expect(limiter.consume(SENDER_A)).toBe(false);
    now += 1_000;
    expect(limiter.consume(SENDER_A)).toBe(true);
  });

  it("enforces the global bucket across distinct authenticated senders", () => {
    let now = 1_000;
    const limiter = createAuthenticatedIngressRateLimiter({
      nowMilliseconds: () => now,
      senderRatePerMinute: 600,
      senderBurst: 10,
      globalRatePerMinute: 60,
      globalBurst: 2,
    });

    expect(limiter.consume(SENDER_A)).toBe(true);
    expect(limiter.consume(SENDER_B)).toBe(true);
    expect(limiter.consume(SENDER_C)).toBe(false);
    now += 1_000;
    expect(limiter.consume(SENDER_C)).toBe(true);
  });

  it("rejects unauthenticated identifiers without consuming capacity", () => {
    const limiter = createAuthenticatedIngressRateLimiter({
      senderRatePerMinute: 1,
      senderBurst: 1,
      globalRatePerMinute: 1,
      globalBurst: 1,
    });

    expect(limiter.consume("not-a-public-key")).toBe(false);
    expect(limiter.consume(SENDER_A)).toBe(true);
  });
});
