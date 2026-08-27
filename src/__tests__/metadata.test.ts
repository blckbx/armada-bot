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
    expect(metadata.install).toMatchObject({
      minHostVersion: ">=2026.7.2-beta.6",
    });
    expect(metadata.build).toEqual({
      openclawVersion: "2026.6.1",
      pluginSdkVersion: "2026.6.1",
    });
    expect((pkg.devDependencies as Record<string, string>).openclaw).toBe(
      "2026.6.1",
    );
    expect(
      (pkg.devDependencies as Record<string, string>)["openclaw-host"],
    ).toBe("npm:openclaw@2026.7.2-beta.6");
    expect((pkg.peerDependencies as Record<string, string>).openclaw).toBe(
      ">=2026.7.2-beta.6",
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
    expect(scripts["test:coverage"]).toBe("vitest run --coverage");
    expect(scripts.audit).toBe("node scripts/validate-host-security.mjs");
    expect(scripts.ci).toContain("test:coverage");
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
    "openclaw/plugin-sdk/channel-ingress-runtime",
    "openclaw/plugin-sdk/media-store",
    "openclaw/plugin-sdk/persistent-dedupe",
    "openclaw/plugin-sdk/state-paths",
    "openclaw/plugin-sdk/web-media",
  ])("resolves pinned public SDK subpath %s", async (subpath) => {
    await expect(import(subpath)).resolves.toBeDefined();
  });

  it("runs the complete release gate in repository CI", async () => {
    const workflow = await readFile(
      new URL(".github/workflows/ci.yml", root),
      "utf8",
    );

    expect(workflow).toContain("npm ci");
    expect(workflow).toContain("npm run ci");
  });

  it("packs a checksummed artifact after changes reach main", async () => {
    const workflow = await readFile(
      new URL(".github/workflows/ci.yml", root),
      "utf8",
    );

    expect(workflow).toContain("github.event_name == 'push'");
    expect(workflow).toContain("github.ref == 'refs/heads/main'");
    expect(workflow).toContain("npm install");
    expect(workflow).toContain("npm test");
    expect(workflow).toContain("npm run build");
    expect(workflow).toContain("npm run package:validate");
    expect(workflow).toContain("npm pack");
    expect(workflow).toContain("sha256sum");
    expect(workflow).toContain("actions/upload-artifact@v4");
    expect(workflow).toContain("name: ${{ steps.pack.outputs.package_file }}");
  });

  it("publishes checksummed packages as version-tagged GitHub releases", async () => {
    const workflow = await readFile(
      new URL(".github/workflows/release.yml", root),
      "utf8",
    );

    expect(workflow).toContain('tags: ["v*"]');
    expect(workflow).toContain("contents: write");
    expect(workflow).toContain("npm install");
    expect(workflow).toContain("npm test");
    expect(workflow).toContain("npm run build");
    expect(workflow).toContain("npm run package:validate");
    expect(workflow).toContain("npm pack");
    expect(workflow).toContain("sha256sum");
    expect(workflow).toContain("gh release create");
    expect(workflow).toContain("--verify-tag");
  });

  it("fails CI when coverage falls below the repository baseline", async () => {
    const config = await readFile(new URL("vitest.config.mjs", root), "utf8");

    expect(config).toContain("thresholds");
    expect(config).toContain("statements: 80");
    expect(config).toContain("branches: 75");
    expect(config).toContain("functions: 80");
    expect(config).toContain("lines: 85");
  });

  it("audits the complete tree and isolates only the exact SDK baseline", async () => {
    const validator = await readFile(
      new URL("scripts/validate-host-security.mjs", root),
      "utf8",
    );

    expect(validator).toContain('runAudit(["--json"])');
    expect(validator).toContain('runAudit(["--omit=dev", "--json"])');
    expect(validator).toContain("node_modules/openclaw/node_modules/");
    expect(validator).toContain("node_modules/openclaw-host");
  });
});
