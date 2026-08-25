import { describe, expect, it } from "vitest";
import { buildAccountStatus, resolveArmadaAccount } from "../account.js";
import {
  TEST_NPUB,
  TEST_NSEC,
  TEST_PUBLIC_KEY,
  validConfig,
} from "./helpers.js";

describe("single Armada account and safe status", () => {
  it("reports the bot public identity after host-owned SecretRef resolution", async () => {
    const cfg = validConfig();
    const resolver = () => Promise.resolve(TEST_NSEC);
    const status = await buildAccountStatus(cfg, resolver);

    expect(status.publicKey).toBe(TEST_PUBLIC_KEY);
    expect(status.bot).toEqual({ publicKey: TEST_PUBLIC_KEY, npub: TEST_NPUB });
    expect(JSON.stringify(status)).not.toContain(TEST_NSEC);
  });

  it("never includes a rejected resolved secret in status or errors", async () => {
    const badSecret = "nsec1do-not-leak-this-value";
    const status = await buildAccountStatus(validConfig(), () =>
      Promise.resolve(badSecret),
    );
    expect(status.configured).toBe(false);
    expect(status.lastError).toBe(
      "Nostr bot identity is unavailable or invalid.",
    );
    expect(JSON.stringify(status)).not.toContain(badSecret);
  });

  it("preserves sanitized live relay readiness in account status", async () => {
    const status = await buildAccountStatus(
      validConfig(),
      () => Promise.resolve(TEST_NSEC),
      {
        accountId: "default",
        running: true,
        connected: true,
        statusState: "ready",
        healthState: "healthy",
        probe: { liveSubscriptions: 2, announcementVerified: true },
      },
    );

    expect(status).toMatchObject({
      running: true,
      connected: true,
      statusState: "ready",
      healthState: "healthy",
      probe: { liveSubscriptions: 2, announcementVerified: true },
      publicKey: TEST_PUBLIC_KEY,
    });
    expect(JSON.stringify(status)).not.toContain(TEST_NSEC);
  });

  it("resolves one default account without touching transport", () => {
    const account = resolveArmadaAccount(validConfig());
    expect(account).toMatchObject({
      accountId: "default",
      enabled: true,
      configured: true,
      name: "OpenClaw",
    });
  });
});
