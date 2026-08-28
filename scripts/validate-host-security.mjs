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
const minimumHost = `>=${sdkBaseline}`;
if (
  pkg.peerDependencies?.openclaw !== minimumHost ||
  pkg.openclaw?.install?.minHostVersion !== minimumHost ||
  pkg.devDependencies?.openclaw !== sdkBaseline ||
  pkg.devDependencies?.["openclaw-host"] !== undefined ||
  pkg.dependencies?.openclaw !== undefined
) {
  throw new Error("OpenClaw host and SDK baseline metadata disagree.");
}

const baselineLock = lock.packages?.["node_modules/openclaw"];
if (
  baselineLock?.version !== sdkBaseline ||
  baselineLock.dev !== true ||
  lock.packages?.["node_modules/openclaw-host"] !== undefined
) {
  throw new Error("OpenClaw host and SDK baseline lock entries disagree.");
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
const unexpected = vulnerabilities.filter(
  (vulnerability) =>
    !Array.isArray(vulnerability.nodes) ||
    vulnerability.nodes.length === 0 ||
    vulnerability.nodes.some(
      (node) => node !== baselineRoot && !node.startsWith(baselinePrefix),
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
  `Validated zero plugin production vulnerabilities. The development-only OpenClaw ${sdkBaseline} SDK/runtime smoke tree has ${baselineCount} explicitly isolated audit findings; audit the installed host separately before deployment.`,
);

function getVulnerabilityCount(report) {
  const count = report.metadata?.vulnerabilities?.total;
  if (report.auditReportVersion !== 2 || !Number.isSafeInteger(count)) {
    throw new Error("npm audit returned an incomplete report.");
  }
  return count;
}
