import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

import {
  annotateFailure,
  clearCallRing,
  clearShownRenders,
  defaultDeps,
  ISSUE_REPO,
  labelsFor,
  makeReportId,
  prefilledUrl,
  recentCalls,
  recordCall,
  redact,
  reportIssue,
  withCallRecord,
  type GhResult,
  type ReportDeps,
} from "./reportIssue.js";
import { findTool } from "../toolRegistry.js";

beforeEach(() => {
  clearCallRing();
  clearShownRenders();
});

// ---- fakes -----------------------------------------------------------------

const SECRETS = {
  ip: "192.168.50.77",
  user: "gamer7",
  osUser: "alice",
  host: "steamdeck-living-room.local",
  v6: "2001:db8:85a3::8a2e:370:7334",
};

interface GhLog {
  calls: Array<{ args: string[]; stdin?: string }>;
}

function fakeDeps(over: Partial<ReportDeps> = {}, gh: { authed?: boolean; create?: (args: string[]) => GhResult } = {}): { deps: ReportDeps; log: GhLog } {
  const log: GhLog = { calls: [] };
  const deps: ReportDeps = {
    now: () => Date.parse("2026-11-02T10:00:00Z"),
    workspace: () => "C:\\Users\\alice\\Documents\\bonsAI",
    home: () => "C:\\Users\\alice",
    osUser: () => SECRETS.osUser,
    hostname: () => "ALICE-PC",
    deckEnv: () => ({ DECK_IP: SECRETS.ip, DECK_USER: SECRETS.user }),
    machines: () => [
      { name: "deck", kind: "deck", os: "steamos", host: SECRETS.host, user: SECRETS.user },
      { name: "this-pc", kind: "standin", os: "windows" },
    ],
    doctor: async () => ({
      checks: [
        { name: "deck.env has the real Deck's address", ok: true, saw: `DECK_IP=${SECRETS.ip}, DECK_USER=${SECRETS.user}`, fix: "" },
        { name: "MCP config points at a real server", ok: false, saw: `C:\\Users\\alice\\Documents\\bonsAI\\.mcp.json points at /home/alice/x on ${SECRETS.v6}`, fix: "fix it" },
      ],
      okCount: 1,
      failCount: 1,
      unknownCount: 0,
      summary: "1 ok, 1 failing, 0 could not be checked",
    }),
    latch: () =>
      ({
        armed: true,
        stoppedSince: null,
        stoppedBy: null,
        reason: null,
        latchPath: "C:\\Users\\alice\\.config\\decky-plugin-studio\\automation-stop.json",
        machinesStopped: [],
        tunnels: [],
        padToolFound: true,
        summary: "armed",
      }) as ReturnType<ReportDeps["latch"]>,
    calls: () => [
      { at: "2026-11-02T09:59:00.000Z", tool: "deck_readFocus", ok: false, durationMs: 41, error: `Error: cannot reach ${SECRETS.ip}`, reportId: "rabc123" },
    ],
    ledger: () => null,
    versions: () => ({ root: "0.3.11", extension: "0.3.11", server: "0.3.11", serverInfo: "decky-plugin-studio 0.3.11" }),
    gh: async (args, stdin) => {
      log.calls.push({ args, stdin });
      if (args[0] === "auth") return { code: gh.authed === false ? 1 : 0, stdout: "", stderr: "" };
      if (gh.create) return gh.create(args);
      return { code: 0, stdout: "https://github.com/qd313/decky-plugin-studio/issues/42\n", stderr: "" };
    },
    ...over,
  };
  return { deps, log };
}

const NARRATIVE = {
  title: "deck_readFocus times out",
  body: `Saw it on ${SECRETS.ip} as ${SECRETS.user}@${SECRETS.ip}, home C:\\Users\\alice\\x. reportId rabc123.`,
  surface: "server",
};

function everything(r: unknown): string {
  // The whole result, plus the prefilled link decoded, as one searchable string.
  const json = JSON.stringify(r);
  const url = (r as { prefilledUrl?: string }).prefilledUrl;
  return json + "\n" + (url ? decodeURIComponent(url) : "");
}

// ---- redaction -------------------------------------------------------------

test("redact: IPv4 and IPv6 addresses go, timestamps and versions stay", () => {
  const r = redact(
    "a 10.0.0.5 b 2001:db8::1 c fe80::1%eth0 d ::ffff:192.168.1.1 e 2001:0db8:0000:0000:0000:0000:0000:0001 " +
      "at 2026-11-02T12:34:56.789Z 12:34:56 version 0.3.11 port 7682",
  );
  assert.equal(
    r.text,
    "a <ip> b <ip> c <ip> d <ip> e <ip> at 2026-11-02T12:34:56.789Z 12:34:56 version 0.3.11 port 7682",
  );
  assert.equal(r.counts["IPv4 address"], 1);
  assert.equal(r.counts["IPv6 address"], 4);
});

test("redact: an out-of-range dotted quad is left alone", () => {
  assert.equal(redact("build 999.1.1.1").text, "build 999.1.1.1");
});

test("redact: home paths in every spelling, and the workspace", () => {
  const spec = { workspace: "C:\\Users\\alice\\Documents\\bonsAI", home: "C:\\Users\\alice" };
  const r = redact(
    [
      "C:\\Users\\alice\\Documents\\bonsAI\\src",
      "C:/Users/alice/Documents/bonsAI/src",
      '"C:\\\\Users\\\\alice\\\\Documents\\\\bonsAI"',
      "C:\\Users\\bob\\other",
      "/c/Users/carol/x",
      "/home/dave/.config",
      "/Users/erin/Library",
      "D:\\Users\\frank\\z",
    ].join("\n"),
    spec,
  );
  assert.doesNotMatch(r.text, /alice|bob|carol|dave|erin|frank/i);
  assert.match(r.text, /<workspace>/);
  assert.match(r.text, /~\/\.config/);
});

test("redact: deck.env values go everywhere; generic names only in context", () => {
  const r = redact(
    `user gamer7 logged in. ssh deck@box. DECK_USER=deck DECK_IP=${SECRETS.ip}. the deck is asleep. host ${SECRETS.host}`,
    { ips: [SECRETS.ip], users: ["gamer7", "deck"], hosts: [SECRETS.host] },
  );
  assert.doesNotMatch(r.text, /gamer7|192\.168|steamdeck-living/);
  assert.match(r.text, /DECK_USER=<redacted>/);
  assert.match(r.text, /DECK_IP=<redacted>/);
  assert.match(r.text, /<user>@box/);
  assert.match(r.text, /the deck is asleep/, "the word deck, the product, must survive");
});

test("redact: emails and token shapes", () => {
  const r = redact(
    "me@example.com ghp_abcdefghijklmnopqrstuvwxyz0123456789 sk-abcdefghijklmnopqrstuvwxyz Bearer abcdefghijklmnop1234567890",
  );
  assert.equal(r.text, "<email> <token> <token> Bearer <token>");
});

// ---- reportId and the ring --------------------------------------------------

test("annotateFailure stamps the error, keeps its class, and fills the ring", () => {
  class Boom extends Error {
    name = "Boom";
  }
  const err = new Boom("first line\nsecond line");
  const out = annotateFailure("deck_walkTo", err, 12, () => Date.parse("2026-11-02T10:00:00Z")) as Error;
  assert.equal(out, err, "same object");
  assert.ok(out instanceof Boom);
  const id = makeReportId("deck_walkTo", "2026-11-02T10:00:00.000Z");
  assert.match(id, /^r[0-9a-f]{6}$/);
  assert.match(String(out), new RegExp(`\\[DPS report id: ${id}\\]`));
  assert.match(String(out), /studio_reportIssue/);
  assert.deepEqual(recentCalls(1)[0], {
    at: "2026-11-02T10:00:00.000Z",
    tool: "deck_walkTo",
    ok: false,
    durationMs: 12,
    error: "first line",
    reportId: id,
  });
});

test("annotateFailure does not stamp twice, wraps a non-Error, and leaves studio_reportIssue's own refusals unstamped", () => {
  const once = annotateFailure("t", new Error("x")) as Error;
  const twice = annotateFailure("t", once) as Error;
  assert.equal((twice.message.match(/DPS report id/g) ?? []).length, 1);
  const wrapped = annotateFailure("t", "a string") as Error;
  assert.ok(wrapped instanceof Error);
  assert.match(wrapped.message, /^a string\n\[DPS report id: r[0-9a-f]{6}\]/);
  const own = annotateFailure("studio_reportIssue", new Error("needs a title")) as Error;
  assert.equal(own.message, "needs a title");
  assert.equal(recentCalls(1)[0].tool, "studio_reportIssue", "still recorded");
});

test("withCallRecord records a success and rethrows a stamped failure", async () => {
  assert.equal(await withCallRecord("a_tool", async () => 5), 5);
  await assert.rejects(
    withCallRecord("b_tool", async () => {
      throw new Error("nope");
    }),
    /nope\n\[DPS report id: r[0-9a-f]{6}\]/,
  );
  const [a, b] = recentCalls(2);
  assert.deepEqual([a.tool, a.ok, b.tool, b.ok], ["a_tool", true, "b_tool", false]);
});

test("the ring keeps the last 50 calls", () => {
  for (let i = 0; i < 60; i++) recordCall({ at: String(i), tool: "t", ok: true, durationMs: i });
  assert.equal(recentCalls(100).length, 50);
  assert.equal(recentCalls(1)[0].at, "59");
  assert.equal(recentCalls(100)[0].at, "10");
});

// ---- the dry run -------------------------------------------------------------

test("dryRun defaults to true: returns the text and a token, runs no gh create", async () => {
  const { deps, log } = fakeDeps();
  const r = await reportIssue(NARRATIVE, deps);
  assert.equal(r.dryRun, true);
  assert.equal(r.posted, false);
  assert.match(r.confirmToken, /^[0-9a-f]{16}$/);
  assert.deepEqual(r.labels, ["surface:server", "source:agent"]);
  assert.ok(!log.calls.some((c) => c.args[0] === "issue"), "no issue create on a dry run");
  assert.equal(r.gh.authenticated, true);
  assert.match(r.markdown, /^Saw it on/);
  for (const heading of ["#### Versions", "#### studio_doctor", "#### Machines", "#### Killswitch latch", "#### Recent calls"]) {
    assert.ok(r.markdown.includes(heading), heading);
  }
  assert.match(r.markdown, /rabc123/);
  assert.match(r.summary, /Nothing was posted/);
});

test("the render, the result and the prefilled link hold none of the seeded secrets", async () => {
  const { deps } = fakeDeps();
  const r = await reportIssue({ ...NARRATIVE, title: `readFocus fails for ${SECRETS.user} on ${SECRETS.ip}` }, deps);
  const all = everything(r);
  for (const secret of [SECRETS.ip, SECRETS.user, SECRETS.osUser, SECRETS.host, SECRETS.v6, "8a2e:370", "C:\\\\Users", "/home/", "ALICE-PC"]) {
    assert.ok(!all.toLowerCase().includes(secret.toLowerCase()), `leaked: ${secret}`);
  }
  assert.ok(r.redaction.replacements > 5);
  assert.ok(r.redaction.byKind["IPv4 address"] >= 1 || r.redaction.byKind["deck.env value"] >= 1);
});

test("machines appear as name, kind and os only", async () => {
  const { deps } = fakeDeps();
  const r = await reportIssue(NARRATIVE, deps);
  assert.match(r.markdown, /- deck: kind deck, os steamos/);
  assert.match(r.markdown, /- this-pc: kind standin, os windows/);
  assert.doesNotMatch(r.markdown, /steamdeck-living|<host>|press|bridgePort/);
});

test("without a ledger the bundle shows the server's own ring; with one it shows the ledger tail", async () => {
  const a = await reportIssue(NARRATIVE, fakeDeps().deps);
  assert.match(a.markdown, /this server process's own ring; no runs\/ledger/);
  assert.match(a.markdown, /deck_readFocus FAILED 41 ms \| Error: cannot reach <ip> \| rabc123/);

  const { deps } = fakeDeps({ ledger: () => ({ file: "runs/ledger/2026-11-02.ndjson", lines: ['{"tool":"deck_walkTo","ok":true}', '{"tool":"deck_sweep","ok":false}'] }) });
  const b = await reportIssue(NARRATIVE, deps);
  assert.match(b.markdown, /Last 2 ledger line\(s\), from runs\/ledger\/2026-11-02\.ndjson/);
  assert.doesNotMatch(b.markdown, /this server process's own ring/);
});

test("a source that throws becomes 'could not be read', not a failed report", async () => {
  const { deps } = fakeDeps({
    doctor: async () => {
      throw new Error("python exploded");
    },
    machines: () => {
      throw new Error("machines.json is not JSON");
    },
  });
  const r = await reportIssue(NARRATIVE, deps);
  assert.match(r.markdown, /studio_doctor could not be read: python exploded/);
  assert.match(r.markdown, /the machine list could not be read: machines\.json is not JSON/);
  assert.match(r.markdown, /#### Killswitch latch/);
});

test("a latch that is set shows who and why", async () => {
  const { deps } = fakeDeps({
    latch: () =>
      ({ armed: false, stoppedSince: "2026-11-02T09:00:00Z", stoppedBy: "status-bar", reason: "ring on Play", latchPath: "x", machinesStopped: [], tunnels: [], padToolFound: true, summary: "" }) as ReturnType<ReportDeps["latch"]>,
  });
  const r = await reportIssue(NARRATIVE, deps);
  assert.match(r.markdown, /"armed": false/);
  assert.match(r.markdown, /"stoppedBy": "status-bar"/);
  assert.match(r.markdown, /ring on Play/);
});

test("a fence in the evidence cannot close the bundle's code block early", async () => {
  const { deps } = fakeDeps({ ledger: () => ({ file: "runs/ledger/x.ndjson", lines: ["before ```` after"] }) });
  const r = await reportIssue(NARRATIVE, deps);
  assert.match(r.markdown, /\n`````text\nbefore ```` after\n`````\n/);
});

test("validation: title, body, surface, source", async () => {
  const { deps } = fakeDeps();
  await assert.rejects(reportIssue({ ...NARRATIVE, title: "  " }, deps), /needs a title/);
  await assert.rejects(reportIssue({ ...NARRATIVE, body: "" }, deps), /needs a body/);
  await assert.rejects(reportIssue({ ...NARRATIVE, title: "x".repeat(201) }, deps), /under 200/);
  await assert.rejects(reportIssue({ ...NARRATIVE, surface: "moon" }, deps), /surface must be one of/);
  await assert.rejects(reportIssue({ ...NARRATIVE, source: "robot" }, deps), /source must be/);
});

test("labels: surface optional, source defaults to agent", async () => {
  assert.deepEqual(labelsFor(undefined, "agent"), ["source:agent"]);
  const r = await reportIssue({ title: "t", body: "b", source: "human", surface: "deck" }, fakeDeps().deps);
  assert.deepEqual(r.labels, ["surface:deck", "source:human"]);
  assert.match(r.markdown, /Labels requested: `surface:deck`, `source:human`/);
});

// ---- posting -----------------------------------------------------------------

test("a post without a token, with a stranger's token, or for different text is refused and runs no gh create", async () => {
  const { deps, log } = fakeDeps();
  const dry = await reportIssue(NARRATIVE, deps);
  await assert.rejects(reportIssue({ ...NARRATIVE, dryRun: false }, deps), /needs a confirmToken/);
  await assert.rejects(reportIssue({ ...NARRATIVE, dryRun: false, confirmToken: "0000000000000000" }, deps), /has not shown a render with that confirmToken/);
  await assert.rejects(reportIssue({ ...NARRATIVE, body: NARRATIVE.body + " (edited)", dryRun: false, confirmToken: dry.confirmToken }, deps), /differ from the ones the confirmToken was issued for/);
  await assert.rejects(reportIssue({ ...NARRATIVE, surface: "deck", dryRun: false, confirmToken: dry.confirmToken }, deps), /differ/);
  assert.ok(!log.calls.some((c) => c.args[0] === "issue"));
});

test("a confirmed post sends exactly the text the dry run returned, through gh, once", async () => {
  const { deps, log } = fakeDeps();
  const dry = await reportIssue(NARRATIVE, deps);
  const post = await reportIssue({ ...NARRATIVE, dryRun: false, confirmToken: dry.confirmToken }, deps);
  assert.equal(post.posted, true);
  assert.equal(post.via, "gh");
  assert.equal(post.issueUrl, "https://github.com/qd313/decky-plugin-studio/issues/42");
  assert.equal(post.labelsApplied, true);
  const create = log.calls.find((c) => c.args[0] === "issue");
  assert.ok(create);
  assert.equal(create.stdin, dry.markdown, "the body posted is byte-for-byte the one shown");
  assert.deepEqual(create.args.slice(0, 4), ["issue", "create", "--repo", ISSUE_REPO]);
  assert.equal(create.args[create.args.indexOf("--title") + 1], dry.title);
  assert.deepEqual(
    create.args.flatMap((a, i) => (a === "--label" ? [create.args[i + 1]] : [])),
    ["surface:server", "source:agent"],
  );
  assert.ok(create.args.includes("--body-file") && create.args.includes("-"));
  // The token is spent.
  await assert.rejects(reportIssue({ ...NARRATIVE, dryRun: false, confirmToken: dry.confirmToken }, deps), /has not shown/);
});

test("a post posts the shown text even when the bundle has moved on since", async () => {
  let calls = 0;
  const { deps, log } = fakeDeps({ calls: () => [{ at: "t", tool: "x", ok: true, durationMs: ++calls }] });
  const dry = await reportIssue(NARRATIVE, deps);
  await reportIssue({ ...NARRATIVE, dryRun: false, confirmToken: dry.confirmToken }, deps);
  assert.equal(log.calls.find((c) => c.args[0] === "issue")?.stdin, dry.markdown);
  assert.equal(calls, 1, "the bundle was collected once, not again at post time");
});

test("gh not authenticated: no create, a prefilled URL comes back", async () => {
  const { deps, log } = fakeDeps({}, { authed: false });
  const dry = await reportIssue(NARRATIVE, deps);
  assert.equal(dry.gh.authenticated, false);
  const post = await reportIssue({ ...NARRATIVE, dryRun: false, confirmToken: dry.confirmToken }, deps);
  assert.equal(post.posted, false);
  assert.equal(post.via, "url");
  assert.ok(post.prefilledUrl.startsWith(`https://github.com/${ISSUE_REPO}/issues/new?title=`));
  assert.ok(!log.calls.some((c) => c.args[0] === "issue"));
  assert.match(post.summary, /gh auth status exited 1/);
});

test("gh missing from the machine counts as not authenticated", async () => {
  const { deps } = fakeDeps({ gh: async () => ({ code: null, stdout: "", stderr: "", error: "spawn gh ENOENT" }) });
  const dry = await reportIssue(NARRATIVE, deps);
  assert.equal(dry.gh.authenticated, false);
  assert.match(dry.gh.detail, /ENOENT/);
});

test("a missing label retries once without labels and says so", async () => {
  let creates = 0;
  const { deps } = fakeDeps({}, {
    create: (args) => {
      creates++;
      return args.includes("--label")
        ? { code: 1, stdout: "", stderr: "could not add label: 'surface:server' not found" }
        : { code: 0, stdout: "https://github.com/qd313/decky-plugin-studio/issues/43\n", stderr: "" };
    },
  });
  const dry = await reportIssue(NARRATIVE, deps);
  const post = await reportIssue({ ...NARRATIVE, dryRun: false, confirmToken: dry.confirmToken }, deps);
  assert.equal(creates, 2);
  assert.equal(post.posted, true);
  assert.equal(post.labelsApplied, false);
  assert.match(post.summary, /without labels/);
});

test("a gh failure that is not about labels posts nothing and is not retried", async () => {
  let creates = 0;
  const { deps } = fakeDeps({}, {
    create: () => {
      creates++;
      return { code: 1, stdout: "", stderr: "HTTP 502: bad gateway" };
    },
  });
  const dry = await reportIssue(NARRATIVE, deps);
  const post = await reportIssue({ ...NARRATIVE, dryRun: false, confirmToken: dry.confirmToken }, deps);
  assert.equal(creates, 1);
  assert.equal(post.posted, false);
  assert.match(post.summary, /HTTP 502/);
  // Still usable: the token was not spent by a failure.
  const again = await reportIssue({ ...NARRATIVE, dryRun: false, confirmToken: dry.confirmToken }, deps);
  assert.equal(again.posted, false);
});

test("tokens expire after an hour", async () => {
  let t = Date.parse("2026-11-02T10:00:00Z");
  const { deps } = fakeDeps({ now: () => t });
  const dry = await reportIssue(NARRATIVE, deps);
  t += 61 * 60_000;
  await assert.rejects(reportIssue({ ...NARRATIVE, dryRun: false, confirmToken: dry.confirmToken }, deps), /has not shown/);
});

// ---- the prefilled link --------------------------------------------------------

test("prefilledUrl carries title, body and labels; a long body is cut to fit and says so", () => {
  const short = prefilledUrl("A & B", "line one\nline two", ["surface:server", "source:agent"]);
  assert.equal(short.truncated, false);
  assert.equal(
    short.url,
    `https://github.com/${ISSUE_REPO}/issues/new?title=A%20%26%20B&body=line%20one%0Aline%20two&labels=surface%3Aserver,source%3Aagent`,
  );
  const long = prefilledUrl("t", "word ".repeat(5000), ["source:agent"]);
  assert.equal(long.truncated, true);
  assert.ok(long.url.length <= 7000, `${long.url.length}`);
  assert.match(decodeURIComponent(long.url), /did not fit in this link/);
});

// ---- the real pieces ------------------------------------------------------------

test("the default ledger reader takes the last 20 lines of the newest ndjson", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-"));
  const dir = path.join(ws, "runs", "ledger");
  fs.mkdirSync(dir, { recursive: true });
  const old = path.join(dir, "old.ndjson");
  const fresh = path.join(dir, "new.ndjson");
  fs.writeFileSync(old, '{"from":"old"}\n');
  fs.writeFileSync(fresh, Array.from({ length: 30 }, (_, i) => `{"n":${i}}`).join("\n") + "\n");
  fs.utimesSync(old, new Date(2020, 0, 1), new Date(2020, 0, 1));
  fs.writeFileSync(path.join(dir, "notes.txt"), "ignored");
  const got = defaultDeps().ledger(ws, 20);
  assert.ok(got);
  assert.equal(got.file, path.join("runs", "ledger", "new.ndjson"));
  assert.equal(got.lines.length, 20);
  assert.equal(got.lines[0], '{"n":10}');
  assert.equal(got.lines[19], '{"n":29}');
  assert.equal(defaultDeps().ledger(fs.mkdtempSync(path.join(os.tmpdir(), "noledger-")), 20), null);
});

test("the registry entry says dryRun is the default and needs title and body", () => {
  const t = findTool("studio_reportIssue");
  assert.ok(t);
  assert.deepEqual(t.inputSchema.required, ["title", "body"]);
  assert.equal((t.inputSchema.properties.dryRun as { default: boolean }).default, true);
  assert.deepEqual((t.inputSchema.properties.surface as { enum: string[] }).enum, ["deck", "standin", "extension", "server"]);
  assert.match(t.description, /never without showing you the text first/);
});
