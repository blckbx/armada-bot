import path from "node:path";
import {
  createClaimableDedupe,
  type ClaimableDedupeClaimResult,
  type ClaimableDedupeOptions,
} from "openclaw/plugin-sdk/persistent-dedupe";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";

const HEX_32 = /^[0-9a-f]{64}$/u;
const MEMORY_MAX_SIZE = 4_096;
const FILE_MAX_ENTRIES = 20_000;

export class ReplayProtectionError extends Error {
  constructor() {
    super("Replay protection is unavailable.");
    this.name = "ReplayProtectionError";
  }
}

export interface ClaimableDedupeLike {
  claim(
    key: string,
    options?: { namespace?: string },
  ): Promise<ClaimableDedupeClaimResult>;
  commit(key: string, options?: { namespace?: string }): Promise<boolean>;
  release(key: string, options?: { namespace?: string; error?: unknown }): void;
}

export interface ReplayClaim {
  commit(): Promise<void>;
  release(error?: unknown): void;
}

export interface ReplayGate {
  readonly degraded: boolean;
  claim(rumorId: string): Promise<ReplayClaim | null>;
}

export interface ClaimableReplayGateOptions {
  readonly accountId: string;
  readonly botPublicKey: string;
  readonly maxMessageAgeSeconds: number;
  readonly stateDir?: string;
  readonly dedupe?: ClaimableDedupeLike;
  readonly createDedupe?: (
    options: Extract<ClaimableDedupeOptions, { resolveFilePath: unknown }>,
  ) => ClaimableDedupeLike;
  readonly onDegraded?: () => void;
}

export class ClaimableReplayGate implements ReplayGate {
  private readonly dedupe: ClaimableDedupeLike;
  private readonly namespace: string;
  private readonly onDegraded: (() => void) | undefined;
  private diskErrorRevision = 0;
  private degradedValue = false;

  constructor(options: ClaimableReplayGateOptions) {
    if (
      !HEX_32.test(options.botPublicKey) ||
      !Number.isSafeInteger(options.maxMessageAgeSeconds) ||
      options.maxMessageAgeSeconds < 1
    ) {
      throw new ReplayProtectionError();
    }
    this.namespace = `armada-dm:${sanitize(options.accountId)}:${options.botPublicKey}`;
    this.onDegraded = options.onDegraded;
    if (options.dedupe !== undefined) {
      this.dedupe = options.dedupe;
      return;
    }
    const stateDir = options.stateDir ?? resolveStateDir();
    const create = options.createDedupe ?? createClaimableDedupe;
    this.dedupe = create({
      ttlMs: options.maxMessageAgeSeconds * 1_000,
      memoryMaxSize: MEMORY_MAX_SIZE,
      fileMaxEntries: FILE_MAX_ENTRIES,
      resolveFilePath: (namespace) =>
        path.join(
          stateDir,
          "plugins",
          "armada-dm",
          "replay-dedupe",
          `${sanitize(namespace)}.json`,
        ),
      onDiskError: () => {
        this.diskErrorRevision += 1;
      },
    });
  }

  get degraded(): boolean {
    return this.degradedValue;
  }

  async claim(rumorId: string): Promise<ReplayClaim | null> {
    if (this.degradedValue || !HEX_32.test(rumorId)) {
      throw new ReplayProtectionError();
    }
    for (;;) {
      const revision = this.diskErrorRevision;
      let result: ClaimableDedupeClaimResult;
      try {
        result = await this.dedupe.claim(rumorId, {
          namespace: this.namespace,
        });
      } catch {
        this.markDegraded();
        throw new ReplayProtectionError();
      }
      if (this.diskErrorRevision !== revision) {
        this.dedupe.release(rumorId, { namespace: this.namespace });
        this.markDegraded();
        throw new ReplayProtectionError();
      }
      if (result.kind === "duplicate") return null;
      if (result.kind === "inflight") {
        try {
          if (await result.pending) return null;
        } catch {
          // The winning turn released its claim. This waiter may retry.
        }
        continue;
      }
      let settled = false;
      return {
        commit: async () => {
          if (settled) return;
          settled = true;
          const commitRevision = this.diskErrorRevision;
          try {
            await this.dedupe.commit(rumorId, {
              namespace: this.namespace,
            });
          } catch {
            this.markDegraded();
            throw new ReplayProtectionError();
          }
          if (this.diskErrorRevision !== commitRevision) {
            this.markDegraded();
            throw new ReplayProtectionError();
          }
        },
        release: (error?: unknown) => {
          if (settled) return;
          settled = true;
          this.dedupe.release(rumorId, {
            namespace: this.namespace,
            ...(error === undefined ? {} : { error }),
          });
        },
      };
    }
  }

  private markDegraded(): void {
    if (this.degradedValue) return;
    this.degradedValue = true;
    try {
      this.onDegraded?.();
    } catch {
      // A status observer cannot restore intake after a disk failure.
    }
  }
}

function sanitize(value: string): string {
  const trimmed = value.trim();
  const safe = trimmed.replace(/[^a-zA-Z0-9_-]/gu, "_");
  return safe || "default";
}
