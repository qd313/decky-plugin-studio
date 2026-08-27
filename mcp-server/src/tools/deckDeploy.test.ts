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
import { proc, quoteRemotePath, moveDeployedPluginIntoPlace } from "../deploy/deployHelpers.js";

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

    const moveCall = calls.find((c) => c.includes("sudo cp -a"));
    assert.ok(moveCall, `expected one elevated move command among: ${JSON.stringify(calls)}`);
    // Quoted since the safety pass: the tilde stays outside so the remote
  // shell still expands it, the rest is one literal segment.
  assert.match(moveCall!, /sudo cp -a \S+ ~\/'homebrew\/plugins\/bonsAI'/);
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
            if (cmd.includes("sudo cp -a")) {
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

/*
 * The guard in front of `sudo rm -rf`.
 *
 * The remote deploy replaces ~/homebrew/plugins/<name> with an elevated
 * command, and <name> is plugin.json's `name` field verbatim -- detectPlugin()
 * validates nothing, so `valid: true` only means the file parsed. Without a
 * check here, a blank name deletes the whole plugins directory, a name with a
 * space deletes two wrong paths, and a name with shell punctuation runs as
 * root on the Deck. These tests assert the refusal happens in the name
 * function itself, before any command string is built.
 */
const REFUSED_NAMES: Array<[string, string]> = [
  ["", "blank -- would target the plugins directory itself"],
  ["   ", "whitespace only -- trims to blank"],
  [".", "would target the plugins directory itself"],
  ["..", "would target the plugins directory's parent"],
  ["My Plugin", "a space word-splits an unquoted rm -rf into two paths"],
  ["foo; rm -rf ~", "command separator"],
  ["$(id)", "command substitution"],
  ["`id`", "backtick substitution"],
  ["foo/../bar", "path traversal"],
  ["foo/bar", "escapes the single directory level it is allowed"],
  ["*", "a glob would match every installed plugin"],
];

for (const [name, why] of REFUSED_NAMES) {
  test(`remotePluginDirName refuses ${JSON.stringify(name)} (${why})`, () => {
    assert.throws(
      () => remotePluginDirName(name),
      /not a usable directory name/,
      `${JSON.stringify(name)} must not reach the elevated command`
    );
  });
}

test("remotePluginDirName still accepts the ordinary names people actually use", () => {
  for (const ok of ["bonsAI", "decky-plugin-studio", "my_plugin", "Plugin.2", "a"]) {
    assert.equal(remotePluginDirName(ok), ok);
  }
});

test("a refused name never reaches ssh -- no remote command is emitted at all", () => {
  const calls: string[] = [];
  const realExec = proc.execSync;
  proc.execSync = ((cmd: string) => {
    calls.push(cmd);
    return "";
  }) as typeof proc.execSync;
  try {
    assert.throws(() => remotePluginDirName(""), /not a usable directory name/);
  } finally {
    proc.execSync = realExec;
  }
  assert.deepEqual(calls, [], "the guard must refuse before anything is executed");
});

test("quoteRemotePath keeps ~ expandable but makes the rest one literal segment", () => {
  // The tilde has to stay outside the quotes or the remote shell never expands
  // it; everything after it is quoted so a space cannot split the argument.
  assert.equal(quoteRemotePath("~/homebrew/plugins/bonsAI"), "~/'homebrew/plugins/bonsAI'");
  assert.equal(quoteRemotePath("/tmp/decky-studio-deploy-1-x"), "'/tmp/decky-studio-deploy-1-x'");
  assert.equal(quoteRemotePath("~/a b"), "~/'a b'");
  // POSIX escape for a quote inside single quotes: close, literal, reopen.
  const q = String.fromCharCode(39);
  assert.equal(quoteRemotePath(`~/it${q}s`), `~/${q}it${q}\\${q}${q}s${q}`);
});

test("the elevated move quotes every path and never uses local command substitution", () => {
  const calls: string[] = [];
  const realExec = proc.execSync;
  proc.execSync = ((cmd: string) => {
    calls.push(cmd);
    return "";
  }) as typeof proc.execSync;
  try {
    moveDeployedPluginIntoPlace("deck", "1.2.3.4", "/tmp/stage-1", "~/homebrew/plugins/bonsAI", "bonsAI");
  } finally {
    proc.execSync = realExec;
  }
  assert.equal(calls.length, 1);
  const cmd = calls[0];
  // Merge, not replace: the deploy set does not include everything the
  // installed directory holds (bonsAI keeps its seed data in data/), so a
  // deploy must not delete what it cannot put back.
  assert.match(cmd, /sudo cp -a '\/tmp\/stage-1'\/\. ~\/'homebrew\/plugins\/bonsAI'\//);
  assert.ok(!/rm -rf ~/.test(cmd), 'the target directory must never be removed');
  assert.match(cmd, /sudo rm -rf '\/tmp\/stage-1'/);
  // `$(dirname ...)` here would be run by a POSIX shell on the LOCAL side,
  // before ssh ever saw the string.
  assert.ok(!cmd.includes("$("), "no command substitution in the ssh argument");
});
