import { execFileSync } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { getPublicKey } from "nostr-tools/pure";

const root = dirname(
  fileURLToPath(new URL("../package.json", import.meta.url)),
);
const temporaryDirectory = await mkdtemp(
  join(tmpdir(), "armada-dm-package-smoke-"),
);

try {
  const packed = JSON.parse(
    execFileSync(
      "npm",
      [
        "--cache",
        "/tmp/armada-bot-npm-cache",
        "pack",
        "--json",
        "--pack-destination",
        temporaryDirectory,
      ],
      { cwd: root, encoding: "utf8" },
    ),
  );
  const packageResult = packed[0];
  const filename = packageResult?.filename;
  if (typeof filename !== "string") fail();
  const files = packageResult?.files;
  if (!Array.isArray(files) || files.length === 0) fail();
  const allowedRootFiles = new Set([
    "LICENSE",
    "README.md",
    "SECURITY.md",
    "openclaw.plugin.json",
    "package.json",
  ]);
  assert(
    files.every(
      (file) =>
        typeof file?.path === "string" &&
        (allowedRootFiles.has(file.path) ||
          (file.path.startsWith("dist/") &&
            !file.path.includes("__tests__") &&
            !file.path.endsWith(".map"))),
    ),
  );

  execFileSync(
    "tar",
    ["-xzf", join(temporaryDirectory, filename), "-C", temporaryDirectory],
    { stdio: "ignore" },
  );
  const extracted = join(temporaryDirectory, "package");
  await symlink(
    join(root, "node_modules"),
    join(extracted, "node_modules"),
    "dir",
  );

  const runtime = await import(
    pathToFileURL(join(extracted, "dist/index.js")).href
  );
  const setup = await import(
    pathToFileURL(join(extracted, "dist/setup-entry.js")).href
  );
  assert(runtime.default.id === "armada-dm");
  assert(runtime.default.channelPlugin.id === "nostr");
  assert(setup.default.plugin.id === "nostr");
  assert(setup.default.plugin.setup === undefined);

  const now = 1_750_000_000;
  const botSecretKey = scalar(1);
  const ownerSecretKey = scalar(2);
  const botPublicKey = getPublicKey(botSecretKey);
  const ownerPublicKey = getPublicKey(ownerSecretKey);
  const request = runtime.createDirectMessage({
    senderSecretKey: ownerSecretKey,
    recipientPublicKey: botPublicKey,
    content: "packed request",
    now,
  });
  const admitted = runtime.unwrapDirectMessage({
    wrap: request.recipient.wrap,
    recipientSecretKey: botSecretKey,
    recipientPublicKey: botPublicKey,
    now,
  });
  const response = runtime.createDirectMessage({
    senderSecretKey: botSecretKey,
    recipientPublicKey: ownerPublicKey,
    content: "packed response",
    replyToEventId: admitted.rumorId,
    now,
  });
  const received = runtime.unwrapDirectMessage({
    wrap: response.recipient.wrap,
    recipientSecretKey: ownerSecretKey,
    recipientPublicKey: ownerPublicKey,
    now,
  });

  assert(admitted.content === "packed request");
  assert(received.content === "packed response");
  assert(received.replyToEventId === admitted.rumorId);
  console.log(
    "Validated the packed runtime/setup entries and NIP-17 round trip.",
  );
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

function scalar(lastByte) {
  const value = new Uint8Array(32);
  value[31] = lastByte;
  return value;
}

function assert(condition) {
  if (!condition) fail();
}

function fail() {
  throw new Error("Packed artifact smoke test failed.");
}
