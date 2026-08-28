import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const lock = JSON.parse(
  await readFile(new URL("../package-lock.json", import.meta.url), "utf8"),
);

const sdkBaseline = "2026.6.34";
const secureHostVersion = "2026.7.2-beta.6";
const minimumSecureHost = `>=${secureHostVersion}`;
if (
  pkg.peerDependencies?.openclaw !== minimumSecureHost ||
  pkg.openclaw?.install?.minHostVersion !== minimumSecureHost ||
  pkg.devDependencies?.openclaw !== sdkBaseline ||
  pkg.devDependencies?.["openclaw-host"] !==
    `npm:openclaw@${secureHostVersion}` ||
  pkg.dependencies?.openclaw !== undefined
) {
  throw new Error("OpenClaw host security and SDK baseline metadata disagree.");
}

const baselineLock = lock.packages?.["node_modules/openclaw"];
const hostLock = lock.packages?.["node_modules/openclaw-host"];
if (
  baselineLock?.version !== sdkBaseline ||
  baselineLock.dev !== true ||
  hostLock?.version !== secureHostVersion ||
  hostLock.dev !== true
) {
  throw new Error(
    "OpenClaw host security and SDK baseline lock entries disagree.",
  );
}

function runAudit(args) {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(npmCommand, ["audit", ...args], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.signal || !result.stdout) {
    throw new Error("npm audit could not produce a complete JSON report.");
  }

  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error("npm audit returned invalid JSON.");
  }
}

const productionAudit = runAudit(["--omit=dev", "--json"]);
const productionCount = getVulnerabilityCount(productionAudit);
if (productionCount !== 0) {
  throw new Error("Production dependencies contain known vulnerabilities.");
}

const completeAudit = runAudit(["--json"]);
const baselineCount = getVulnerabilityCount(completeAudit);
const vulnerabilities = Object.values(completeAudit.vulnerabilities ?? {});
const baselineRoot = "node_modules/openclaw";
const baselinePrefix = "node_modules/openclaw/node_modules/";
const forbiddenHostPrefix = "node_modules/openclaw-host";
const unexpected = vulnerabilities.filter(
  (vulnerability) =>
    !Array.isArray(vulnerability.nodes) ||
    vulnerability.nodes.length === 0 ||
    vulnerability.nodes.some(
      (node) =>
        node.startsWith(forbiddenHostPrefix) ||
        (node !== baselineRoot && !node.startsWith(baselinePrefix)),
    ),
);

if (unexpected.length > 0) {
  const names = unexpected
    .map(({ name }) => name)
    .sort()
    .join(", ");
  throw new Error(`Unisolated development vulnerabilities: ${names}`);
}

console.log(
  `Validated zero production/deploy-host vulnerabilities. The development-only OpenClaw ${sdkBaseline} SDK tree has ${baselineCount} explicitly isolated audit findings.`,
);

function getVulnerabilityCount(report) {
  const count = report.metadata?.vulnerabilities?.total;
  if (report.auditReportVersion !== 2 || !Number.isSafeInteger(count)) {
    throw new Error("npm audit returned an incomplete report.");
  }
  return count;
}
