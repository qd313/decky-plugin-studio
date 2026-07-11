import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { discoverPluginRpcMethods } from "./rpcDiscover.js";
import { isPreviewRpcAllowed, resolveRpcAllowlist } from "./rpcAllowlist.js";

describe("rpcDiscover", () => {
  it("discovers public Plugin methods", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "decky-rpc-"));
    const mainPy = path.join(tmp, "main.py");
    fs.writeFileSync(
      mainPy,
      `class Plugin:
    async def _main(self):
        pass

    async def get_greeting(self, name: str = "hi"):
        return name

    def load_settings(self):
        return {}
`
    );
    const methods = discoverPluginRpcMethods(mainPy);
    assert.ok(methods.includes("get_greeting"));
    assert.ok(methods.includes("load_settings"));
    assert.equal(methods.includes("_main"), false);
    fs.rmSync(tmp, { recursive: true });
  });
});

describe("rpcAllowlist", () => {
  it("allows discovered methods in discover mode", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "decky-rpc-"));
    fs.writeFileSync(
      path.join(tmp, "main.py"),
      `class Plugin:
    async def get_greeting(self):
        return "ok"
`
    );
    fs.mkdirSync(path.join(tmp, ".decky"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, ".decky", "preview.json"),
      JSON.stringify({ rpcMode: "discover" })
    );
    process.env.DECKY_STUDIO_WORKSPACE = tmp;
    assert.equal(isPreviewRpcAllowed("get_greeting", tmp), true);
    assert.equal(isPreviewRpcAllowed("_main", tmp), false);
    const snap = resolveRpcAllowlist(tmp);
    assert.ok(snap.allowed.includes("get_greeting"));
    fs.rmSync(tmp, { recursive: true });
  });
});
