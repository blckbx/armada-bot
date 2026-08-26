import { readFile } from "node:fs/promises";
import { URL } from "node:url";

const BASELINE = "2026.6.1";
const SUBPATHS = [
  "openclaw/plugin-sdk/core",
  "openclaw/plugin-sdk/json-schema-runtime",
  "openclaw/plugin-sdk/secret-input-runtime",
  "openclaw/plugin-sdk/status-helpers",
  "openclaw/plugin-sdk/channel-inbound",
  "openclaw/plugin-sdk/media-store",
  "openclaw/plugin-sdk/web-media",
];

const packageJson = JSON.parse(
  await readFile(
    new URL("../node_modules/openclaw/package.json", import.meta.url),
    "utf8",
  ),
);

if (packageJson.version !== BASELINE) {
  throw new Error("OpenClaw SDK baseline does not match the pinned version.");
}

for (const subpath of SUBPATHS) {
  await import(subpath);
}

console.log(
  `Validated ${SUBPATHS.length} public SDK imports against OpenClaw ${BASELINE}.`,
);
