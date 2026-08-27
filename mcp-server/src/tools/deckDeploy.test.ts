/**
 * Tests for deck_deploy: the manifest-case target and the root-owned
 * destination.
 *
 * `deployPlugin()` used to normalize plugin.json's `name` (lowercase, spaces
 * stripped) for BOTH the local homebrew/plugins copy and the remote Deck
 * target. Decky loader names the installed directory on the Deck straight
 * from the manifest, case intact -- a plugin named "bonsAI" landed at
 * homebrew/plugins/bonsai on the Deck, a directory the loader never reads.
 *
 * Separately, once a plugin has been installed once through the QAM, decky
 * loader owns homebrew/plugins/<name> as root. A plain scp as the deploy user
 * cannot overwrite it, and the old code's only reaction was to let
 * `execSync` throw the failed scp command line verbatim -- not helpful when
 * the real problem is "root owns this directory, you don't".
 *
 * These tests pin both fixes with the exec layer faked: no ssh/scp ever
 * touches a real Deck. They fail against the pre-fix code -- either because
 * `proc`/`localPluginDirName`/`remotePluginDirName` do not exist yet, or
 * (imagining those names existed but forwarded to the old bodies) because the
 * old code lowercased the remote target, scp'd straight to the final
 * directory with no staging step, and surfaced a bare "Command failed: ..."
 * on a permission error instead of a diagnostic.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { deployPlugin, localPluginDirName, remotePluginDirName } from "./plugin.js";
import { deployRemote } from "./deck.js";
import { proc } from "../deploy/deployHelpers.js";

function makeFixturePlugin(name: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dps-deploy-plugin-"));
  fs.writeFileSync(path.join(root, "plugin.json"), JSON.stringify({ name, version: "1.0.0" }));
  fs.mkdirSync(path.join(root, "dist"));
  fs.writeFileSync(path.join(root, "dist", "index.js"), "// built");
  fs.writeFileSync(path.join(root, "main.py"), "# entry");
  return root;
}

/** Swaps the exec seam for the duration of `fn`, always restoring it after. */
async function withFakeExec<T>(impl: (cmd: string) => string, fn: () => Promise<T> | T): Promise<T> {
  const original = proc.execSync;
  proc.execSync = ((cmd: string) => impl(cmd)) as unknown as typeof proc.execSync;
  try {
    return await fn();
  } finally {
    proc.execSync = original;
  }
}

const realEnv = {
  USERPROFILE: process.env.USERPROFILE,
  HOME: process.env.HOME,
  DECK_IP: process.env.DECK_IP,
  DECK_USER: process.env.DECK_USER,
  WORKSPACE: process.env.DECKY_STUDIO_WORKSPACE,
};

/*
 * deployPlugin() unconditionally probes/creates ~/homebrew/plugins to decide
 * whether a local deploy is possible, even when the caller asks for "remote"
 * explicitly. os.homedir() reads USERPROFILE/HOME at call time (not cached),
 * so redirecting those here keeps that probe off the real machine's home
 * directory -- the same trick killswitch.test.ts uses for the same reason.
 */
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "dps-deploy-home-"));

after(() => {
  process.env.USERPROFILE = realEnv.USERPROFILE;
  process.env.HOME = realEnv.HOME;
  process.env.DECK_IP = realEnv.DECK_IP;
  process.env.DECK_USER = realEnv.DECK_USER;
  process.env.DECKY_STUDIO_WORKSPACE = realEnv.WORKSPACE;
  fs.rmSync(tempHome, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Defect A: the remote target must match plugin.json's `name`, case intact.
// ---------------------------------------------------------------------------

test("localPluginDirName normalizes -- local copies own the directory they create", () => {
  assert.equal(localPluginDirName("bonsAI"), "bonsai");
  assert.equal(localPluginDirName("My Plugin"), "my-plugin");
});

test("remotePluginDirName preserves the manifest's case exactly", () => {
  assert.equal(remotePluginDirName("bonsAI"), "bonsAI");
  assert.equal(remotePluginDirName("  bonsAI  "), "bonsAI");
});

test('deployPlugin("remote") targets the manifest\'s exact case, never a lowercased sibling', async () => {
  process.env.USERPROFILE = tempHome;
  process.env.HOME = tempHome;
  process.env.DECK_IP = "203.0.113.5";
  process.env.DECK_USER = "deck";
  const root = makeFixturePlugin("bonsAI");
  process.env.DECKY_STUDIO_WORKSPACE = root;
  const calls: string[] = [];

  try {
    const result = await withFakeExec(
      (cmd) => {
        calls.push(cmd);
        return "";
      },
      () => deployPlugin("remote")
    );
    assert.equal(result.mode, "remote");
    assert.equal((result as { target: string }).target, "~/homebrew/plugins/bonsAI");
    assert.ok(
      !calls.some((c) => c.includes("bonsai")),
      `a lowercased "bonsai" leaked into an exec call: ${JSON.stringify(calls)}`
    );
    assert.ok(
      calls.some((c) => c.includes("bonsAI")),
      `expected the manifest's exact case to appear in at least one exec call: ${JSON.stringify(calls)}`
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Defect B: stage via a deck-writable temp dir, move into place elevated,
// and turn a permission failure into a diagnostic instead of a raw echo.
// ---------------------------------------------------------------------------

test("deployRemote stages through a deck-writable temp dir, then moves into place with one elevated command", async () => {
  process.env.DECK_IP = "203.0.113.5";
  process.env.DECK_USER = "deck";
  const root = makeFixturePlugin("bonsAI");
  const calls: string[] = [];

  try {
    const result = await withFakeExec(
      (cmd) => {
        calls.push(cmd);
        return "";
      },
      () => deployRemote(root, "bonsAI")
    );

    assert.equal(result.target, "~/homebrew/plugins/bonsAI");

    const scpCalls = calls.filter((c) => c.startsWith("scp"));
    assert.ok(scpCalls.length > 0, "expected at least one scp call");
    assert.ok(
      scpCalls.every((c) => !c.includes("~/homebrew/plugins")),
      `an scp call wrote straight to the (possibly root-owned) target instead of staging first: ${JSON.stringify(
        scpCalls
      )}`
    );
    assert.ok(
      scpCalls.every((c) => /\/tmp\/decky-studio-deploy-\S*bonsAI/.test(c)),
      `expected every scp call to stage into a temp dir named after the plugin: ${JSON.stringify(scpCalls)}`
    );

    const moveCall = calls.find((c) => c.includes("sudo mv"));
    assert.ok(moveCall, `expected one elevated move command among: ${JSON.stringify(calls)}`);
    assert.match(moveCall!, /sudo mv \S+ ~\/homebrew\/plugins\/bonsAI\b/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a root-owned destination produces a diagnostic naming the target and the fix, not a raw command echo", async () => {
  process.env.DECK_IP = "203.0.113.5";
  process.env.DECK_USER = "deck";
  const root = makeFixturePlugin("bonsAI");

  try {
    await assert.rejects(
      () =>
        withFakeExec(
          (cmd) => {
            if (cmd.includes("sudo mv")) {
              throw Object.assign(new Error(`Command failed: ${cmd}`), {
                status: 1,
                stdout: "",
                stderr:
                  "mv: cannot move '/tmp/decky-studio-deploy-1-bonsAI' to " +
                  "'/home/deck/homebrew/plugins/bonsAI': Permission denied",
              });
            }
            return "";
          },
          () => deployRemote(root, "bonsAI")
        ),
      (err: unknown) => {
        assert.ok(err instanceof Error, "expected an Error");
        const msg = (err as Error).message;
        assert.match(msg, /~\/homebrew\/plugins\/bonsAI/, "diagnostic should name the target path");
        assert.match(msg, /root|sudo|elevat/i, "diagnostic should explain the ownership problem");
        assert.ok(
          !/^Command failed:/.test(msg),
          `expected a diagnostic, not the raw failed command echoed back: ${msg}`
        );
        return true;
      }
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
