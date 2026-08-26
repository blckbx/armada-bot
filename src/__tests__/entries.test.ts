import { describe, expect, it, vi } from "vitest";

describe("plugin entries", () => {
  it("imports runtime and setup entries without background work", async () => {
    const timer = vi.spyOn(globalThis, "setTimeout");
    const interval = vi.spyOn(globalThis, "setInterval");
    const runtime = await import("../../index.js");
    const setup = await import("../../setup-entry.js");

    expect(runtime.default.id).toBe("armada-dm");
    expect(runtime.default.channelPlugin.id).toBe("nostr");
    expect(runtime.default.channelPlugin.capabilities.media).toBe(true);
    expect("outbound" in runtime.default.channelPlugin).toBe(false);
    expect(setup.default.plugin.id).toBe("nostr");
    expect(timer).not.toHaveBeenCalled();
    expect(interval).not.toHaveBeenCalled();

    expect(setup.default.plugin.setup).toBeUndefined();
  });

  it("turns duplicate nostr ownership into an actionable local failure", async () => {
    const { default: entry } = await import("../../index.js");
    const api = {
      registrationMode: "discovery",
      registerChannel: () => {
        throw new Error("channel nostr is already registered");
      },
      runtime: {},
    };

    expect(() => entry.register(api as never)).toThrow(
      /channel "nostr" is already owned.*disable or remove/i,
    );
  });
});
