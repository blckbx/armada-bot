import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { ARMADA_CHANNEL_JSON_SCHEMA } from "../config-json-schema.js";

const root = new URL("../../", import.meta.url);

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(new URL(path, root), "utf8")) as Record<
    string,
    unknown
  >;
}

describe("package and manifest contracts", () => {
  it("uses one package, plugin, channel, and exact SDK baseline", async () => {
    const pkg = await readJson("package.json");
    const manifest = await readJson("openclaw.plugin.json");
    const metadata = pkg.openclaw as Record<string, unknown>;
    const channel = metadata.channel as Record<string, unknown>;

    expect(pkg.name).toBe("openclaw-armada-dm");
    expect(manifest.id).toBe("armada-dm");
    expect(manifest.kind).toBe("channel");
    expect(manifest.channels).toEqual(["nostr"]);
    expect(channel.id).toBe("nostr");
    expect(metadata.extensions).toEqual(["./dist/index.js"]);
    expect(metadata.setupEntry).toBe("./dist/setup-entry.js");
    expect(metadata).not.toHaveProperty("runtimeExtensions");
    expect(metadata).not.toHaveProperty("runtimeSetupEntry");
    expect(metadata.compat).toEqual({ pluginApi: ">=2026.6.1" });
    expect(metadata.build).toEqual({
      openclawVersion: "2026.6.1",
      pluginSdkVersion: "2026.6.1",
    });
    expect((pkg.devDependencies as Record<string, string>).openclaw).toBe(
      "2026.6.1",
    );
    const scripts = pkg.scripts as Record<string, string>;
    expect(scripts["sdk:baseline"]).toBe(
      "node scripts/validate-sdk-imports.mjs",
    );
    expect(scripts["smoke:built"]).toBe(
      "node scripts/smoke-built-artifact.mjs",
    );
    expect(scripts["smoke:package"]).toBe(
      "node scripts/smoke-packed-artifact.mjs",
    );
    expect(scripts["smoke:install"]).toBe(
      "node scripts/smoke-install-paths.mjs",
    );
    expect(scripts.ci).toContain("smoke:built");
    expect(scripts.ci).toContain("smoke:package");
    expect(scripts.ci).toContain("smoke:install");
  });

  it("publishes only the intended runtime and documentation allowlist", async () => {
    const pkg = await readJson("package.json");
    expect(pkg.files).toEqual([
      "dist",
      "openclaw.plugin.json",
      "README.md",
      "LICENSE",
      "SECURITY.md",
    ]);
    expect(pkg).not.toHaveProperty("scripts.postinstall");
    expect(pkg).not.toHaveProperty("scripts.prepare");
  });

  it("keeps the manifest channel schema identical to the runtime JSON contract", async () => {
    const manifest = await readJson("openclaw.plugin.json");
    const channelConfigs = manifest.channelConfigs as Record<
      string,
      { schema: Record<string, unknown> }
    >;
    expect(channelConfigs.nostr?.schema).toEqual(ARMADA_CHANNEL_JSON_SCHEMA);
  });

  it.each([
    "openclaw/plugin-sdk/core",
    "openclaw/plugin-sdk/json-schema-runtime",
    "openclaw/plugin-sdk/secret-input-runtime",
    "openclaw/plugin-sdk/status-helpers",
    "openclaw/plugin-sdk/channel-inbound",
    "openclaw/plugin-sdk/media-store",
    "openclaw/plugin-sdk/web-media",
  ])("resolves pinned public SDK subpath %s", async (subpath) => {
    await expect(import(subpath)).resolves.toBeDefined();
  });
});
