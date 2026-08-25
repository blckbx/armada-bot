import { existsSync, readdirSync, readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const manifest = JSON.parse(readFileSync("openclaw.plugin.json", "utf8"));

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

assert(pkg.name === "openclaw-armada-dm", "Unexpected package name.");
assert(manifest.id === "armada-dm", "Unexpected plugin ID.");
assert(
  manifest.kind === "channel",
  "Manifest must declare native channel kind.",
);
assert(
  JSON.stringify(manifest.channels) === '["nostr"]',
  "Manifest must own only nostr.",
);
assert(
  pkg.openclaw.extensions[0] === "./dist/index.js",
  "Runtime entry must be built JS.",
);
assert(
  pkg.openclaw.setupEntry === "./dist/setup-entry.js",
  "Setup entry must be built JS.",
);
assert(
  !("runtimeExtensions" in pkg.openclaw),
  "Later runtimeExtensions metadata is forbidden.",
);
assert(
  !("runtimeSetupEntry" in pkg.openclaw),
  "Later runtimeSetupEntry metadata is forbidden.",
);
assert(existsSync("dist/index.js"), "Built runtime entry is missing.");
assert(existsSync("dist/setup-entry.js"), "Built setup entry is missing.");

for (const required of [
  "dist/index.js",
  "dist/setup-entry.js",
  "openclaw.plugin.json",
  "README.md",
  "LICENSE",
  "SECURITY.md",
]) {
  assert(existsSync(required), `Publish input is missing ${required}.`);
}

const distFiles = readdirSync("dist", { recursive: true, encoding: "utf8" });
assert(
  distFiles.every((file) => !file.includes("__tests__")),
  "Built output contains test files.",
);

console.log(
  `Validated package metadata and ${distFiles.length} dist entries for ${pkg.name}.`,
);
