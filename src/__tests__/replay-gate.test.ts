import { describe, expect, it, vi } from "vitest";
import { createClaimableDedupe } from "openclaw/plugin-sdk/persistent-dedupe";
import {
  ClaimableReplayGate,
  ReplayProtectionError,
  type ClaimableDedupeLike,
} from "../replay-gate.js";

describe("claimable replay gate", () => {
  it("commits successful dispatch and releases failed dispatch", async () => {
    const commit = vi.fn(() => Promise.resolve(true));
    const release = vi.fn();
    const dedupe: ClaimableDedupeLike = {
      claim: vi.fn(() => Promise.resolve({ kind: "claimed" as const })),
      commit,
      release,
    };
    const gate = new ClaimableReplayGate({
      accountId: "default",
      botPublicKey: "a".repeat(64),
      maxMessageAgeSeconds: 3_600,
      dedupe,
    });

    const successful = await gate.claim("b".repeat(64));
    expect(successful).not.toBeNull();
    await successful?.commit();
    const failed = await gate.claim("c".repeat(64));
    failed?.release(new Error("dispatch failed"));

    expect(commit).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it("fails closed and remains degraded after persistent storage errors", async () => {
    let onDiskError: ((error: unknown) => void) | undefined;
    const release = vi.fn();
    const dedupe: ClaimableDedupeLike = {
      claim: vi.fn(() => {
        onDiskError?.(new Error("sensitive disk detail"));
        return Promise.resolve({ kind: "claimed" as const });
      }),
      commit: vi.fn(() => Promise.resolve(true)),
      release,
    };
    const gate = new ClaimableReplayGate({
      accountId: "default",
      botPublicKey: "a".repeat(64),
      maxMessageAgeSeconds: 3_600,
      createDedupe: (options) => {
        onDiskError = options.onDiskError;
        return dedupe;
      },
      stateDir: "/tmp/armada-replay-test",
    });

    await expect(gate.claim("b".repeat(64))).rejects.toThrow(
      ReplayProtectionError,
    );
    await expect(gate.claim("c".repeat(64))).rejects.toThrow(
      "Replay protection is unavailable.",
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it("allows only one concurrent winner for the same inner rumor", async () => {
    const gate = new ClaimableReplayGate({
      accountId: "default",
      botPublicKey: "a".repeat(64),
      maxMessageAgeSeconds: 3_600,
      dedupe: createClaimableDedupe({
        ttlMs: 3_600_000,
        memoryMaxSize: 32,
      }),
    });
    const rumorId = "b".repeat(64);
    const first = await gate.claim(rumorId);
    const secondPending = gate.claim(rumorId);

    await first?.commit();

    await expect(secondPending).resolves.toBeNull();
  });
});
