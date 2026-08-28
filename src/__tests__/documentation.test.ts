import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const root = new URL("../../", import.meta.url);

describe("manual configuration documentation", () => {
  it("omits development dependencies from local plugin installation", async () => {
    const readme = await readFile(new URL("README.md", root), "utf8");

    expect(readme).toContain(
      "npm install --omit=dev /absolute/path/to/openclaw-armada-dm",
    );
    expect(readme).not.toContain(
      "npm install /absolute/path/to/openclaw-armada-dm",
    );
  });

  it("uses the current package version in release commands", async () => {
    const readme = await readFile(new URL("README.md", root), "utf8");

    expect(readme).toContain("openclaw-armada-dm-0.1.3.tgz");
    expect(readme).toContain('git tag -a v0.1.3 -m "v0.1.3"');
    expect(readme).not.toContain("0.1.1");
  });

  it("documents openclaw.json configuration without requiring a wizard", async () => {
    const readme = await readFile(new URL("README.md", root), "utf8");
    const slice = await readFile(
      new URL(
        "docs/implementation-slices/08-setup-interoperability-and-release.md",
        root,
      ),
      "utf8",
    );

    expect(readme).toContain("## Manual channel configuration");
    expect(readme).toContain('"channels"');
    expect(readme).toContain('"publishInbox": true');
    expect(readme).toContain("## Troubleshooting");
    expect(readme).toContain("## Bot-key rotation");
    expect(readme).toContain("/path/to/.openclaw/secrets/nostr_nsec");
    expect(readme).not.toContain("/home/claw/.openclaw/secrets/nostr_nsec");
    expect(slice).toContain("/path/to/.openclaw/secrets/nostr_nsec");
    expect(slice).toContain("no interactive setup wizard");
    expect(slice).not.toContain(
      "Implement `openclaw channels add --channel nostr`",
    );
  });

  it("documents completed resource controls and residual crash semantics", async () => {
    const security = await readFile(new URL("SECURITY.md", root), "utf8");

    expect(security).toContain("token buckets");
    expect(security).toContain("at-least-once");
    expect(security).not.toContain("are added in Slice 7");
  });

  it("documents encrypted inbound-media support and its trust boundary", async () => {
    const readme = await readFile(new URL("README.md", root), "utf8");
    const security = await readFile(new URL("SECURITY.md", root), "utf8");

    expect(readme).toContain("kind-15 file rumors");
    expect(readme).toContain("kind-14 `imeta`");
    expect(readme).toContain("four attachments");
    expect(readme).toContain("Bot-authored uploads");
    expect(security).toContain("SSRF-guarded media loader");
    expect(security).toContain("plaintext media");
  });
});
