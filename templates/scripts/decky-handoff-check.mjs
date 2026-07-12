#!/usr/bin/env node
/** Remind agents to verify build/deploy evidence before handoff. */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const deckOnly = path.join(root, "tests", "preview-suite", "deck-only.json");
const runbook = path.join(root, "docs", "device-qa-runbook.md");

console.log("decky-handoff: Deck-facing changes need plugin.build + preview smoke or deck.deploy evidence.");

if (fs.existsSync(deckOnly)) {
  try {
    const raw = JSON.parse(fs.readFileSync(deckOnly, "utf8"));
    const scenarios = Array.isArray(raw) ? raw : raw.scenarios ?? [];
    if (!scenarios.length) {
      console.warn("decky-handoff: tests/preview-suite/deck-only.json is empty — add deck-only scenarios.");
    }
    if (!fs.existsSync(runbook)) {
      console.warn("decky-handoff: missing docs/device-qa-runbook.md for deck-only QA.");
    }
  } catch {
    console.warn("decky-handoff: could not parse deck-only.json");
  }
}

process.exit(0);
