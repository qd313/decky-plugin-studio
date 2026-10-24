import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { discoverPluginRpcMethods } from "./rpcDiscover.js";

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

