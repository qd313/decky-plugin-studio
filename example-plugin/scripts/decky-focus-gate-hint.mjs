#!/usr/bin/env node
/** Remind agents that Deck UI edits require focus-graph verification before handoff. */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const testingDoc = path.join(root, "docs", "testing.md");
const promptTesting = path.join(root, "docs", "prompt-testing.md");

console.log(
  "decky-focus-gate: UI edits require decky-ui-change-focus-gate — enumerate stops, Pattern A wiring, docs/testing.md row, deck.deploy verify."
);

if (!fs.existsSync(testingDoc) && !fs.existsSync(promptTesting)) {
  console.warn("decky-focus-gate: no docs/testing.md or docs/prompt-testing.md — add a D-pad test row before ship.");
}

process.exit(0);
