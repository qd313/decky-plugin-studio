import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { TOOLS, TOOL_NAMES, findTool } from "./toolRegistry.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const dispatchSource = readFileSync(path.join(here, "index.ts"), "utf8");

/**
 * Every `case "tools/x":` inside handle() — the plugin-tool dispatch.
 *
 * Scoped to that function on purpose: handleMcp() also has `tools/list` and
 * `tools/call` cases, but those are MCP protocol methods, not plugin tools.
 */
function dispatchToolNames(): Set<string> {
  const start = dispatchSource.indexOf("async function handle(");
  const end = dispatchSource.indexOf("async function handleMcp(");
  assert.ok(start >= 0, "could not locate handle() in index.ts");
  assert.ok(end > start, "could not locate handleMcp() after handle() in index.ts");

  const body = dispatchSource.slice(start, end);
  const names = new Set<string>();
  for (const m of body.matchAll(/case\s+"tools\/([A-Za-z0-9_]+)"\s*:/g)) {
    names.add(m[1]);
  }
  return names;
}

test("registry exposes every dispatched tool", () => {
  const dispatched = dispatchToolNames();
  assert.ok(dispatched.size > 0, "found no dispatch cases — did the switch shape change?");

  // A dispatched tool missing here is reachable from the extension but invisible
  // to every external MCP agent, which is exactly the bug this guards.
  const undiscoverable = [...dispatched].filter((n) => !TOOL_NAMES.has(n)).sort();
  assert.deepEqual(undiscoverable, [], "tools dispatched but absent from the MCP registry");
});

test("registry advertises no tool the dispatch cannot serve", () => {
  const dispatched = dispatchToolNames();
  const phantom = [...TOOL_NAMES].filter((n) => !dispatched.has(n)).sort();
  assert.deepEqual(phantom, [], "tools advertised over MCP that would fail when called");
});

test("tool definitions are well formed for MCP clients", () => {
  for (const tool of TOOLS) {
    assert.match(tool.name, /^[a-z][A-Za-z0-9_]{0,63}$/, `bad tool name: ${tool.name}`);
    assert.ok(tool.description.length > 20, `description too thin: ${tool.name}`);
    assert.equal(tool.inputSchema.type, "object", `schema must be an object: ${tool.name}`);

    // Required entries must actually exist in properties, or clients will send
    // arguments the schema never described.
    for (const req of tool.inputSchema.required ?? []) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(tool.inputSchema.properties, req),
        `${tool.name}: required "${req}" is not among its properties`
      );
    }
  }
});

test("tool names are unique", () => {
  assert.equal(TOOL_NAMES.size, TOOLS.length, "duplicate tool name in registry");
});

test("findTool resolves a known tool and rejects an unknown one", () => {
  assert.equal(findTool("deck_deploy")?.name, "deck_deploy");
  assert.equal(findTool("nope_not_real"), undefined);
});
