import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { discoverFrontendRpcMethods, diffRpc } from "./rpcDiff.js";

describe("rpcDiff", () => {
  it("reports frontend-only and backend-only methods", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "decky-diff-"));
    fs.writeFileSync(
      path.join(tmp, "main.py"),
      `class Plugin:
    async def get_greeting(self):
        return "ok"

    def orphan_backend(self):
        return 1
`
    );
    fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, "src", "index.tsx"),
      `export async function run() {
  await call("get_greeting", "world");
  await call("orphan_frontend", 1);
}
`
    );
    fs.mkdirSync(path.join(tmp, ".decky"), { recursive: true });
    fs.writeFileSync(path.join(tmp, ".decky", "preview.json"), JSON.stringify({ rpcMode: "discover" }));

    process.env.DECKY_STUDIO_WORKSPACE = tmp;
    const frontend = discoverFrontendRpcMethods(tmp);
    assert.ok(frontend.includes("get_greeting"));
    assert.ok(frontend.includes("orphan_frontend"));

    const d = diffRpc(tmp);
    assert.ok(d.matched.includes("get_greeting"));
    assert.ok(d.backendOnly.includes("orphan_backend"));
    assert.ok(d.frontendOnly.includes("orphan_frontend"));

    fs.rmSync(tmp, { recursive: true });
  });
});
