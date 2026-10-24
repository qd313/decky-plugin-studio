/**
 * `.decky/preview.json` outlived the preview. deck_openPlugin reads
 * panelRootSelector from it and deck_deploy runs preDeployCommand from it, so
 * both must keep working with the file name unchanged.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { getPluginConfigPath, loadPluginConfig } from "./pluginConfig.js";

function workspaceWith(contents?: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "decky-plugin-config-"));
  if (contents !== undefined) {
    fs.mkdirSync(path.join(root, ".decky"), { recursive: true });
    fs.writeFileSync(path.join(root, ".decky", "preview.json"), contents);
  }
  return root;
}

test("the config file is still .decky/preview.json", () => {
  assert.equal(
    getPluginConfigPath("/ws"),
    path.join("/ws", ".decky", "preview.json"),
  );
});

test("panelRootSelector and preDeployCommand are read from .decky/preview.json", () => {
  const root = workspaceWith(
    JSON.stringify({ panelRootSelector: ".bonsai-scope", preDeployCommand: "pnpm build" }),
  );
  try {
    const cfg = loadPluginConfig(root);
    assert.equal(cfg.panelRootSelector, ".bonsai-scope");
    assert.equal(cfg.preDeployCommand, "pnpm build");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("keys the preview used to read are ignored, not an error", () => {
  const root = workspaceWith(
    JSON.stringify({ rpcMode: "dev", ipcTimeoutMs: 5, permissions: { network: false }, panelRootSelector: ".x" }),
  );
  try {
    const cfg = loadPluginConfig(root);
    assert.equal(cfg.panelRootSelector, ".x");
    assert.equal(cfg.preDeployCommand, undefined);
    assert.equal("rpcMode" in cfg, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a missing or unparseable file gives an empty config", () => {
  const missing = workspaceWith();
  const broken = workspaceWith("{ not json");
  try {
    assert.deepEqual(loadPluginConfig(missing), {});
    assert.deepEqual(loadPluginConfig(broken), {});
  } finally {
    fs.rmSync(missing, { recursive: true, force: true });
    fs.rmSync(broken, { recursive: true, force: true });
  }
});

test("deploy runs preDeployCommand from the file, in the plugin root", async () => {
  const { runPreDeployHook } = await import("./deploy/deployHelpers.js");
  const root = workspaceWith(
    JSON.stringify({ preDeployCommand: 'node -e "require(\'fs\').writeFileSync(\'ran.txt\', \'yes\')"' }),
  );
  try {
    runPreDeployHook(root);
    assert.equal(fs.readFileSync(path.join(root, "ran.txt"), "utf8"), "yes");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
