#!/usr/bin/env node
/**
 * Claude Code hook adapter for the Decky pack.
 *
 * Cursor hooks filter by file glob in their `matcher`. Claude Code hooks match
 * on TOOL NAME instead, and hand the tool payload to the command on stdin. So
 * the path filtering that Cursor does declaratively has to happen here, which
 * keeps the underlying hint scripts (decky-rpc-drift-hint.mjs and friends)
 * unchanged and shared between both editors.
 *
 * Usage:
 *   decky-claude-hook.mjs --match "<globs>" --run <script.mjs>
 *   decky-claude-hook.mjs --match "<globs>" --message "<text>"
 *   decky-claude-hook.mjs --match "<globs>" --run <script.mjs> --git
 *
 *   --match    Comma-separated globs. Supports *, **, ? and {a,b}.
 *   --run      Script to execute when a path matches.
 *   --message  Text to print when a path matches (for advisory-only hooks).
 *   --git      Match against `git status --porcelain` instead of the edited
 *              file. Used by Stop hooks, which get no file_path — this is how
 *              "were any Deck-facing files touched this session?" is answered.
 *
 * Always exits 0: these are advisory hints, and a non-zero exit would surface
 * as a blocking hook error in Claude Code.
 */
import { execFileSync, execSync } from "child_process";
import fs from "fs";
import path from "path";

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const matchSpec = arg("--match") ?? "**";
const runScript = arg("--run");
const message = arg("--message");
const useGit = process.argv.includes("--git");

function globToRegExp(glob) {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // ** spans directory separators; **/ also matches zero directories
        i++;
        if (glob[i + 1] === "/") i++;
        out += "(?:.*/)?";
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") out += "[^/]";
    else if (c === "{") out += "(?:";
    else if (c === "}") out += ")";
    else if (c === ",") out += "|";
    else if (".+^$()[]\\|/".includes(c)) out += "\\" + c;
    else out += c;
  }
  return new RegExp("^" + out + "$");
}

/**
 * Split the --match list on top-level commas only.
 *
 * A naive split(",") tears "src/**\/*.{ts,tsx}" in half at the brace comma and
 * produces an invalid regex, so brace depth has to be tracked.
 */
function splitPatterns(spec) {
  const out = [];
  let cur = "";
  let depth = 0;
  for (const c of spec) {
    if (c === "{") depth++;
    else if (c === "}") depth--;
    if (c === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

const patterns = splitPatterns(matchSpec).map(globToRegExp);

const normalize = (p) => String(p).replace(/\\/g, "/").replace(/^\.\//, "");

function matches(file) {
  const rel = normalize(path.isAbsolute(file) ? path.relative(process.cwd(), file) : file);
  return patterns.some((re) => re.test(rel));
}

function readStdin() {
  try {
    // fd 0 is the hook payload; empty when invoked manually.
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function changedFilesFromGit() {
  try {
    return execSync("git status --porcelain", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split("\n")
      .map((l) => l.slice(3).trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function fire() {
  if (message) console.log(message);
  if (runScript) {
    try {
      execFileSync(process.execPath, [path.resolve(process.cwd(), runScript)], {
        stdio: ["ignore", "inherit", "inherit"],
      });
    } catch {
      // Hint scripts are advisory; a failure must not block the session.
    }
  }
}

let hit = false;
if (useGit) {
  hit = changedFilesFromGit().some(matches);
} else {
  const raw = readStdin();
  let payload = {};
  try {
    payload = JSON.parse(raw || "{}");
  } catch {
    payload = {};
  }
  const file = payload?.tool_input?.file_path ?? payload?.tool_input?.notebook_path;
  hit = Boolean(file) && matches(file);
}

if (hit) fire();
process.exit(0);
