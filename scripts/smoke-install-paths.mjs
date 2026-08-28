import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";

const root = dirname(
  fileURLToPath(new URL("../package.json", import.meta.url)),
);
const temporaryDirectory = await mkdtemp(
  join(tmpdir(), "armada-dm-install-smoke-"),
);
const childEnvironment = {
  ...process.env,
  NPM_CONFIG_CACHE: "/tmp/armada-bot-npm-cache",
};

try {
  const packed = JSON.parse(
    execFileSync(
      "npm",
      ["pack", "--json", "--pack-destination", temporaryDirectory],
      { cwd: root, encoding: "utf8", env: childEnvironment },
    ),
  );
  const filename = packed[0]?.filename;
  if (typeof filename !== "string") fail();
  const tarball = join(temporaryDirectory, filename);

  const localHost = join(temporaryDirectory, "npm-host");
  await mkdir(localHost);
  await writeFile(
    join(localHost, "package.json"),
    JSON.stringify({ name: "armada-dm-install-smoke", private: true }),
  );
  execFileSync(
    "npm",
    [
      "install",
      "--omit=dev",
      "--ignore-scripts",
      "--no-package-lock",
      "--legacy-peer-deps",
      tarball,
    ],
    { cwd: localHost, stdio: "pipe", env: childEnvironment },
  );
  await symlink(
    join(root, "node_modules/openclaw"),
    join(localHost, "node_modules/openclaw"),
    "dir",
  );
  const locallyInstalled = await import(
    pathToFileURL(
      join(localHost, "node_modules/openclaw-armada-dm/dist/index.js"),
    ).href
  );
  assert(locallyInstalled.default.id === "armada-dm");
  assert(locallyInstalled.default.channelPlugin.id === "nostr");

  const managedState = join(temporaryDirectory, "managed-state");
  const managedConfig = join(managedState, "openclaw.json");
  await mkdir(managedState);
  await writeFile(managedConfig, "{}\n");
  const managedEnvironment = {
    ...childEnvironment,
    OPENCLAW_STATE_DIR: managedState,
    OPENCLAW_CONFIG_PATH: managedConfig,
  };
  const openclawCli = join(root, "node_modules/openclaw/openclaw.mjs");
  execFileSync(
    process.execPath,
    [openclawCli, "plugins", "install", `npm-pack:${tarball}`, "--force"],
    { stdio: "pipe", env: managedEnvironment },
  );
  const inspection = JSON.parse(
    execFileSync(
      process.execPath,
      [openclawCli, "plugins", "inspect", "armada-dm", "--runtime", "--json"],
      { encoding: "utf8", env: managedEnvironment },
    ),
  );
  assert(inspection.plugin?.id === "armada-dm");
  assert(inspection.plugin?.status === "loaded");

  console.log("Validated local npm and OpenClaw npm-pack installation paths.");
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

function assert(condition) {
  if (!condition) fail();
}

function fail() {
  throw new Error("Installation smoke test failed.");
}
