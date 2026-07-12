#!/usr/bin/env node
/** Preview-suite runner — requires Decky: Open Preview in Cursor.
 *  Usage: node scripts/run-preview-suite.mjs [--write|--evidence] [--tier=smoke] [--filter=ID] */
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function findRepoRoot(startDir) {
  let dir = startDir;
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, "tests", "preview-suite"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("Could not find tests/preview-suite — run from a plugin workspace");
}

const repoRoot = findRepoRoot(__dirname);
const suiteDir = path.join(repoRoot, "tests", "preview-suite");
const tierManifestPath = path.join(suiteDir, "tier-manifest.json");
const resultsDir = path.join(repoRoot, "tests", "preview-results");
const evidenceRoot = path.join(repoRoot, "docs", "test-evidence");
const ipcDir = path.join(os.homedir(), ".decky-plugin-studio", "preview-ipc");
const previewStatePath = path.join(os.homedir(), ".decky-plugin-studio", "preview-state.json");

const args = process.argv.slice(2);
const writeBack = args.includes("--write");
const evidenceFlag = args.includes("--evidence") || writeBack;
const updateBaselines = args.includes("--update-baselines");
const filterArg = args.find((a) => a.startsWith("--filter="))?.split("=")[1] ?? "";
const tierArg = args.find((a) => a.startsWith("--tier="))?.split("=")[1] ?? "";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function getGitShaShort() {
  const r = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: repoRoot, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "unknown";
}

function getRunDate() {
  return new Date().toISOString().slice(0, 10);
}

function relRepoPath(absPath) {
  return path.relative(repoRoot, absPath).split(path.sep).join("/");
}

function readPreviewState() {
  if (!fs.existsSync(previewStatePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(previewStatePath, "utf8"));
  } catch {
    return null;
  }
}

function loadTierManifest() {
  if (!fs.existsSync(tierManifestPath)) {
    throw new Error("Missing tests/preview-suite/tier-manifest.json");
  }
  return JSON.parse(fs.readFileSync(tierManifestPath, "utf8"));
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

async function sendIpc(command, timeoutMs = 120_000) {
  fs.mkdirSync(ipcDir, { recursive: true });
  const id = randomUUID();
  const payload = { ...command, id };
  fs.writeFileSync(path.join(ipcDir, `cmd-${id}.json`), JSON.stringify(payload), "utf8");
  if (command.cmd === "injectFocus") {
    await sleep(300);
    return { ok: true };
  }
  const resultPath = path.join(ipcDir, `result-${id}.json`);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(resultPath)) {
      const raw = fs.readFileSync(resultPath, "utf8");
      fs.unlinkSync(resultPath);
      return JSON.parse(raw);
    }
    await sleep(50);
  }
  throw new Error(`IPC timeout for ${command.cmd}`);
}

async function sidecarRpc(method, rpcArgs = []) {
  const state = readPreviewState();
  const port = state?.httpPort ?? 8766;
  const res = await fetch(`http://127.0.0.1:${port}/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method, args: rpcArgs }),
    signal: AbortSignal.timeout(120_000),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

async function preflightPreviewHealth() {
  const state = readPreviewState();
  if (!state?.url) {
    throw new Error(
      "Preview not running: ~/.decky-plugin-studio/preview-state.json missing or has no url.\n" +
        "Open Decky: Open Preview in Cursor first."
    );
  }
  const probe = await sendIpc({ cmd: "snapshotDom" }, 15_000);
  if (!probe.ok) {
    throw new Error(`Preview IPC probe failed: ${probe.error ?? "snapshotDom failed"}`);
  }
  return { ok: true, url: state.url, workspaceRoot: state.workspaceRoot ?? null };
}

function assertStep(step, context) {
  const { type, expect } = step;
  if (type === "domContainsAny") {
    const html = context.lastDom ?? "";
    const needles = Array.isArray(expect) ? expect : [expect];
    if (!needles.some((n) => html.includes(String(n)))) {
      throw new Error(`domContainsAny failed: expected one of ${JSON.stringify(needles)} in DOM`);
    }
  }
  if (type === "focusPathIncludes") {
    const fp = context.lastFocusPath ?? [];
    if (!fp.some((x) => String(x).includes(expect))) {
      throw new Error(`focusPathIncludes failed: ${JSON.stringify(fp)}`);
    }
  }
  if (type === "rpcResult") {
    const text = JSON.stringify(context.lastRpc ?? "");
    if (expect && !text.includes(expect)) {
      throw new Error(`rpcResult failed: expected "${expect}" in ${text.slice(0, 200)}`);
    }
  }
  if (type === "hookResult") {
    const val = JSON.stringify(context.lastHook ?? "");
    if (expect && !val.includes(expect)) {
      throw new Error(`hookResult failed: expected "${expect}" in ${val.slice(0, 200)}`);
    }
  }
  if (type === "compareScreenshot") {
    const pct = context.lastCompareDiffPercent ?? 0;
    const max = Number(expect ?? 1.5);
    if (pct > max) {
      throw new Error(`compareScreenshot failed: diff ${pct}% > ${max}%`);
    }
  }
}

async function comparePng(baselinePath, capturePath, threshold = 1.5) {
  let pixelmatch;
  let PNG;
  try {
    pixelmatch = (await import("pixelmatch")).default;
    PNG = (await import("pngjs")).PNG;
  } catch {
    throw new Error(
      "compareScreenshot requires pixelmatch and pngjs — npm i -D pixelmatch pngjs"
    );
  }
  const img1 = PNG.sync.read(fs.readFileSync(baselinePath));
  const img2 = PNG.sync.read(fs.readFileSync(capturePath));
  if (img1.width !== img2.width || img1.height !== img2.height) {
    return { match: false, diffPercent: 100 };
  }
  const { width, height } = img1;
  const diff = new PNG({ width, height });
  const diffPixels = pixelmatch(img1.data, img2.data, diff.data, width, height, { threshold: 0.1 });
  const diffPercent = (diffPixels / (width * height)) * 100;
  return {
    match: diffPercent <= threshold,
    diffPercent: Math.round(diffPercent * 100) / 100,
    diffPng: diff,
    PNG,
  };
}

async function runCompareScreenshot(step, context) {
  const name = step.baseline ?? step.name;
  if (!name) throw new Error("compareScreenshot requires baseline or name");
  const baselineDir = path.join(repoRoot, "tests", "preview-baselines");
  const baselinePath = path.join(baselineDir, `${name}.png`);
  const res = await sendIpc({ cmd: "captureScreenshot", selector: step.selector });
  if (!res.ok) throw new Error(res.error ?? "captureScreenshot failed");
  const captureDir = path.join(repoRoot, "screenshots", "preview");
  fs.mkdirSync(captureDir, { recursive: true });
  const capturePath = path.join(captureDir, `suite-${name}-${Date.now()}.png`);
  if (res.result?.pngBase64) {
    fs.writeFileSync(capturePath, Buffer.from(res.result.pngBase64, "base64"));
  } else {
    throw new Error("captureScreenshot returned no PNG");
  }
  if (updateBaselines || !fs.existsSync(baselinePath)) {
    fs.mkdirSync(baselineDir, { recursive: true });
    fs.copyFileSync(capturePath, baselinePath);
    context.lastCompareDiffPercent = 0;
    return;
  }
  const threshold = step.threshold ?? 1.5;
  const out = await comparePng(baselinePath, capturePath, threshold);
  context.lastCompareDiffPercent = out.diffPercent;
  if (!out.match && out.diffPng) {
    const diffDir = path.join(captureDir, "diffs");
    fs.mkdirSync(diffDir, { recursive: true });
    fs.writeFileSync(path.join(diffDir, `${name}-diff.png`), out.PNG.sync.write(out.diffPng));
  }
  if (!out.match) {
    throw new Error(`visual diff ${out.diffPercent}% exceeds threshold ${threshold}%`);
  }
}

async function runStep(step, context) {
  switch (step.action) {
    case "sleep":
      await sleep(step.ms ?? 300);
      break;
    case "injectFocus":
      await sendIpc({ cmd: "injectFocus", direction: step.direction });
      break;
    case "runSequence": {
      const res = await sendIpc({
        cmd: "runSequence",
        inputs: step.inputs ?? [],
        delayMs: step.delayMs ?? 80,
      });
      if (!res.ok) throw new Error(res.error ?? "runSequence failed");
      context.lastFocusPath = res.result?.focusPath ?? [];
      context.lastDom = res.result?.domSnapshot ?? "";
      context.lastActive = res.result?.activeElement ?? "";
      break;
    }
    case "snapshotDom": {
      const res = await sendIpc({ cmd: "snapshotDom", selector: step.selector });
      if (!res.ok) throw new Error(res.error ?? "snapshotDom failed");
      context.lastDom = res.result?.html ?? "";
      context.lastActive = res.result?.activeElement ?? "";
      break;
    }
    case "callRpc":
      context.lastRpc = await sidecarRpc(step.method, step.args ?? []);
      break;
    case "previewHook": {
      const res = await sendIpc({
        cmd: "callTestHook",
        method: step.method,
        args: step.args ?? [],
      });
      if (!res.ok) throw new Error(res.error ?? `previewHook ${step.method} failed`);
      const inner = res.result;
      if (inner && typeof inner === "object" && inner.ok === false) {
        throw new Error(inner.error ?? `previewHook ${step.method} failed`);
      }
      context.lastHook = inner ?? res.result;
      break;
    }
    case "assert":
      assertStep(step, context);
      break;
    case "compareScreenshot":
      await runCompareScreenshot(step, context);
      break;
    default:
      throw new Error(`Unknown step action: ${step.action}`);
  }
}

async function runScenario(scenario) {
  const context = {};
  const steps = scenario.steps ?? [];
  const start = Date.now();
  for (const step of steps) {
    try {
      await runStep(step, context);
    } catch (err) {
      err.runnerContext = context;
      throw err;
    }
  }
  return { id: scenario.id, status: "pass", context, durationMs: Date.now() - start };
}

function parseScenarioFile(filePath) {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return Array.isArray(raw) ? raw : raw.scenarios ? raw.scenarios : [raw];
}

function loadScenariosFromFiles(files) {
  const all = [];
  const byId = new Map();
  for (const file of files) {
    const filePath = path.isAbsolute(file) ? file : path.join(suiteDir, file);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Scenario file not found: ${relRepoPath(filePath)}`);
    }
    for (const s of parseScenarioFile(filePath)) {
      all.push(s);
      byId.set(s.id, s);
    }
  }
  return { all, byId };
}

function resolveScenarios() {
  let batchKey = tierArg || "all";
  let files;

  if (tierArg) {
    const manifest = loadTierManifest();
    const batch = manifest.batches?.[tierArg];
    if (!batch) {
      throw new Error(`Unknown tier batch "${tierArg}". Keys: ${Object.keys(manifest.batches ?? {}).join(", ")}`);
    }
    files = batch.file ? [batch.file] : batch.sourceFiles ?? [];
    if (!files.length) throw new Error(`Tier batch "${tierArg}" has no file/sourceFiles`);
  } else if (fs.existsSync(suiteDir)) {
    files = fs
      .readdirSync(suiteDir)
      .filter((f) => f.endsWith(".json") && f !== "tier-manifest.json");
  } else {
    files = [];
  }

  let { all: list } = loadScenariosFromFiles(files);

  if (filterArg) {
    list = list.filter(
      (s) =>
        s.id?.includes(filterArg) ||
        s.tags?.some((t) => t.includes(filterArg) || filterArg.includes(t))
    );
  }

  return { scenarios: list, batchKey };
}

function writeEvidence(evidenceDir, scenario, outcome) {
  fs.mkdirSync(evidenceDir, { recursive: true });
  const ctx = outcome.context ?? {};
  if (ctx.lastDom) fs.writeFileSync(path.join(evidenceDir, "dom-final.html"), ctx.lastDom, "utf8");
  if (ctx.lastFocusPath?.length) writeJson(path.join(evidenceDir, "focus-path.json"), ctx.lastFocusPath);
  writeJson(path.join(evidenceDir, "manifest.json"), {
    scenarioId: scenario.id,
    batch: outcome.batchKey,
    status: outcome.status,
    error: outcome.error ?? null,
    durationMs: outcome.durationMs ?? null,
    gitSha: outcome.gitSha,
    runDate: outcome.runDate,
    previewUrl: readPreviewState()?.url ?? null,
    tags: scenario.tags ?? [],
  });
}

function writeResultsReport(results, meta) {
  fs.mkdirSync(resultsDir, { recursive: true });
  const outPath = path.join(resultsDir, `${meta.runDate}-${meta.batchKey}.json`);
  writeJson(outPath, { date: meta.runDate, batch: meta.batchKey, gitSha: meta.gitSha, results });
  console.log(`\nWrote ${relRepoPath(outPath)}`);
}

function writeBatchSummary(batchRunDir, results, meta) {
  const passed = results.filter((r) => r.status === "pass").length;
  const failed = results.filter((r) => r.status === "fail").length;
  writeJson(path.join(batchRunDir, "batch-summary.json"), {
    batch: meta.batchKey,
    runDate: meta.runDate,
    gitSha: meta.gitSha,
    passed,
    failed,
    total: results.length,
    evidenceRoot: relRepoPath(batchRunDir),
    results: results.map((r) => ({
      id: r.id,
      status: r.status,
      error: r.error ?? null,
      evidenceDir: r.evidenceDir ? relRepoPath(r.evidenceDir) : null,
    })),
  });
}

async function main() {
  const gitSha = getGitShaShort();
  const runDate = getRunDate();
  const runFolder = `${runDate}-${gitSha}`;
  const { scenarios, batchKey } = resolveScenarios();
  const batchRunDir = path.join(evidenceRoot, batchKey, runFolder);
  const meta = { batchKey, gitSha, runDate, runFolder };

  if (!scenarios.length) {
    console.error("No scenarios matched filters.");
    process.exit(1);
  }

  const health = await preflightPreviewHealth();
  console.log(`Preview OK: ${health.url}`);

  console.log(`Batch: ${batchKey} (${scenarios.length} scenario(s))`);
  if (evidenceFlag) console.log(`Evidence: ${relRepoPath(batchRunDir)}/`);

  const results = [];
  for (const scenario of scenarios) {
    process.stdout.write(`\n▶ ${scenario.id} … `);
    const evidenceDir = evidenceFlag ? path.join(batchRunDir, scenario.id) : null;
    try {
      const out = await runScenario(scenario);
      const result = { ...out, evidenceDir, batchKey, gitSha, runDate };
      if (evidenceDir) writeEvidence(evidenceDir, scenario, result);
      results.push(result);
      console.log("PASS");
    } catch (err) {
      const failContext = err.runnerContext ?? {};
      const result = {
        id: scenario.id,
        status: "fail",
        error: String(err),
        evidenceDir,
        batchKey,
        gitSha,
        runDate,
        context: failContext,
      };
      if (evidenceDir) writeEvidence(evidenceDir, scenario, result);
      results.push(result);
      console.log(`FAIL — ${err}`);
    }
  }

  if (evidenceFlag) writeBatchSummary(batchRunDir, results, meta);
  writeResultsReport(results, meta);

  const failed = results.filter((r) => r.status === "fail").length;
  const passed = results.filter((r) => r.status === "pass").length;
  console.log(`\n${passed}/${results.length} passed (${failed} failed)`);
  if (evidenceFlag) console.log(`Evidence root: ${relRepoPath(batchRunDir)}/`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
