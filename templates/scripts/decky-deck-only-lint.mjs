#!/usr/bin/env node
/** Lint deck-only.json has scenarios and runbook reference. */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const deckOnly = path.join(root, "tests", "preview-suite", "deck-only.json");
const runbook = path.join(root, "docs", "device-qa-runbook.md");

if (!fs.existsSync(deckOnly)) {
  console.log("decky-deck-only-lint: no deck-only.json (OK for preview-only plugins)");
  process.exit(0);
}

let scenarios = [];
try {
  const raw = JSON.parse(fs.readFileSync(deckOnly, "utf8"));
  scenarios = Array.isArray(raw) ? raw : raw.scenarios ?? [];
} catch (err) {
  console.error("decky-deck-only-lint: invalid JSON", err);
  process.exit(1);
}

if (!scenarios.length) {
  console.error("decky-deck-only-lint: deck-only.json has no scenarios");
  process.exit(1);
}

if (!fs.existsSync(runbook)) {
  console.error("decky-deck-only-lint: missing docs/device-qa-runbook.md");
  process.exit(1);
}

console.log(`decky-deck-only-lint: OK (${scenarios.length} deck-only scenario(s))`);
process.exit(0);
