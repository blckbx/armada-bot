import { describe, expect, it } from "vitest";
import {
  ArmadaConfigurationError,
  parseArmadaConfig,
  parseChannelConfig,
} from "../config-schema.js";
import { TEST_NPUB, validConfig } from "./helpers.js";

describe("Armada DM configuration", () => {
  it("parses the strict single-account contract and normalizes values", () => {
    const raw = validConfig();
    const channel = (raw.channels as Record<string, Record<string, unknown>>)
      .nostr;
    channel.relays = ["wss://relay.ditto.pub", "wss://relay.ditto.pub/"];

    const parsed = parseArmadaConfig(raw);

    expect(parsed.channel.relays).toEqual(["wss://relay.ditto.pub/"]);
    expect(parsed.channel.allowFrom).toEqual([
      "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
    ]);
    expect(parsed.provider).toEqual({
      source: "file",
      path: "/home/claw/.openclaw/secrets/nostr_nsec",
      mode: "singleValue",
    });
  });

  it("defaults to automatic configured-relay fallback", () => {
    const raw = validConfig();
    const channel = (raw.channels as Record<string, Record<string, unknown>>)
      .nostr;
    delete channel.allowFallbackDelivery;

    expect(parseChannelConfig(channel).allowFallbackDelivery).toBe(true);
  });

  it("defaults to Armada-oriented redundant inbox relays and separate discovery relays", () => {
    const raw = validConfig();
    const channel = (raw.channels as Record<string, Record<string, unknown>>)
      .nostr;
    delete channel.relays;
    delete channel.discoveryRelays;

    const parsed = parseChannelConfig(channel);
    expect(parsed.relays).toEqual([
      "wss://relay.armada.buzz/",
      "wss://relay.ditto.pub/",
      "wss://relay.dreamith.to/",
    ]);
    expect(parsed.discoveryRelays).toEqual([
      "wss://relay.ditto.pub/",
      "wss://relay.dreamith.to/",
    ]);
  });

  it.each([
    ["missing provider", (cfg: Record<string, unknown>) => delete cfg.secrets],
    [
      "wrong provider source",
      (cfg: Record<string, unknown>) =>
        ((
          (cfg.secrets as Record<string, unknown>).providers as Record<
            string,
            unknown
          >
        ).nostr = {
          source: "env",
          allowlist: ["NSEC"],
        }),
    ],
    [
      "wrong secret provider",
      (cfg: Record<string, unknown>) =>
        ((
          (
            (cfg.channels as Record<string, unknown>).nostr as Record<
              string,
              unknown
            >
          ).privateKey as Record<string, unknown>
        ).provider = "other"),
    ],
    [
      "wrong secret id",
      (cfg: Record<string, unknown>) =>
        ((
          (
            (cfg.channels as Record<string, unknown>).nostr as Record<
              string,
              unknown
            >
          ).privateKey as Record<string, unknown>
        ).id = "nsec"),
    ],
    [
      "inline secret",
      (cfg: Record<string, unknown>) =>
        ((
          (cfg.channels as Record<string, unknown>).nostr as Record<
            string,
            unknown
          >
        ).privateKey = "nsec1secret"),
    ],
    [
      "unknown channel key",
      (cfg: Record<string, unknown>) =>
        ((
          (cfg.channels as Record<string, unknown>).nostr as Record<
            string,
            unknown
          >
        ).surprise = true),
    ],
    [
      "empty relays",
      (cfg: Record<string, unknown>) =>
        ((
          (cfg.channels as Record<string, unknown>).nostr as Record<
            string,
            unknown
          >
        ).relays = []),
    ],
    [
      "invalid relay protocol",
      (cfg: Record<string, unknown>) =>
        ((
          (cfg.channels as Record<string, unknown>).nostr as Record<
            string,
            unknown
          >
        ).relays = ["https://relay.example"]),
    ],
    [
      "age less than lookback",
      (cfg: Record<string, unknown>) =>
        ((
          (cfg.channels as Record<string, unknown>).nostr as Record<
            string,
            unknown
          >
        ).maxMessageAgeSeconds = 3600),
    ],
    [
      "malformed allowlist",
      (cfg: Record<string, unknown>) =>
        ((
          (cfg.channels as Record<string, unknown>).nostr as Record<
            string,
            unknown
          >
        ).allowFrom = ["alice"]),
    ],
  ])("rejects %s without echoing values", (_label, mutate) => {
    const raw = validConfig();
    mutate(raw);

    expect(() => parseArmadaConfig(raw)).toThrow(ArmadaConfigurationError);
    try {
      parseArmadaConfig(raw);
    } catch (error) {
      expect(String(error)).not.toContain("nsec1secret");
      expect(String(error)).not.toContain("alice");
    }
  });

  it("requires explicit private-relay consent for ws URLs", () => {
    const raw = validConfig();
    const channel = (raw.channels as Record<string, Record<string, unknown>>)
      .nostr;
    channel.relays = ["ws://relay.internal:8080"];
    expect(() => parseChannelConfig(channel)).toThrow(ArmadaConfigurationError);

    channel.allowPrivateRelays = true;
    expect(parseChannelConfig(channel).relays).toEqual([
      "ws://relay.internal:8080/",
    ]);
  });

  it.each(["pairing", "open", "disabled"])(
    "rejects unsupported %s policy",
    (policy) => {
      const raw = validConfig();
      const channel = (raw.channels as Record<string, Record<string, unknown>>)
        .nostr;
      channel.dmPolicy = policy;

      expect(() => parseChannelConfig(channel)).toThrow(
        ArmadaConfigurationError,
      );
    },
  );

  it.each([
    ["empty", []],
    ["multiple", [TEST_NPUB, "0".repeat(64)]],
    ["wildcard", ["*"]],
  ])("rejects %s owner allowlist", (_label, allowFrom) => {
    const raw = validConfig();
    const channel = (raw.channels as Record<string, Record<string, unknown>>)
      .nostr;
    channel.allowFrom = allowFrom;

    expect(() => parseChannelConfig(channel)).toThrow(ArmadaConfigurationError);
  });
});
