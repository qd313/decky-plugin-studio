/**
 * Tests for the saved-copy check (plan 97, lane X2). The archive on this PC that
 * made every settings snapshot fail on 2026-10-22 had a bad header 148 MB in;
 * these build real archives and damage them the same ways.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { checkTarFile } from "./tarCheck.js";
import { makeTar, tarEntry } from "./__testutil__/tarBuilder.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dps-tarcheck-"));
function write(name: string, data: Buffer): string {
  const f = path.join(dir, name);
  fs.writeFileSync(f, data);
  return f;
}
const bytes = (n: number) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 7 + 13) % 256));

test("a whole archive passes, with its entries counted", async () => {
  const f = write("ok.tar", makeTar([
    { name: "settings/bonsAI/settings.json", data: bytes(1500) },
    { name: "settings/bonsAI/empty", data: Buffer.alloc(0) },
    { name: "data/bonsAI/model.bin", data: bytes(70_000) },
  ]));
  const r = await checkTarFile(f);
  assert.deepEqual(r.ok && r.entries, 3);
});

test("an archive that is cut short (the copy lost its tail) is damaged, and says where", async () => {
  const whole = makeTar([
    { name: "a", data: bytes(4000) },
    { name: "b", data: bytes(900_000) },
  ]);
  const r = await checkTarFile(write("short.tar", whole.subarray(0, 300_000)));
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.match(r.reason, /past the end of the file/);
    assert.equal(r.entry, 1);
  }
});

test("a header damaged in the middle (the 2026-10-22 shape: 'Skipping to next header') is found, even though the length is right", async () => {
  const whole = makeTar([
    { name: "a", data: bytes(2000) },
    { name: "b", data: bytes(3000) },
    { name: "c", data: bytes(500) },
  ]);
  const damaged = Buffer.from(whole);
  const secondHeader = 512 + 2048; // entry a: header + 2000 bytes padded to 2048
  damaged[secondHeader + 5] ^= 0xff; // a name byte: the header checksum no longer matches
  const r = await checkTarFile(write("flipped.tar", damaged));
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.match(r.reason, /bad header checksum/);
    assert.equal(r.offsetBytes, secondHeader);
    assert.equal(r.entry, 1);
  }
});

test("extension entries (long names, pax headers) are read, not counted, and do not trip the check", async () => {
  const longName = "x".repeat(150);
  const f = write("ext.tar", Buffer.concat([
    tarEntry("././@LongLink", Buffer.from(longName + "\0"), "L"),
    tarEntry(longName.slice(0, 99), bytes(100)),
    tarEntry("pax", Buffer.from("30 mtime=1700000000.123456789\n"), "x"),
    tarEntry("dir/", Buffer.alloc(0), "5"),
    Buffer.alloc(1024),
  ]));
  const r = await checkTarFile(f);
  assert.deepEqual(r.ok && r.entries, 2);
});

test("a file that is not a tar at all is damaged, and neither is a stub shorter than one header", async () => {
  const text = await checkTarFile(write("text.tar", Buffer.from("FAKE-TAR-CONTENTS-not-a-real-archive".padEnd(600, "-"))));
  assert.equal(text.ok, false);
  const stub = await checkTarFile(write("stub.tar", Buffer.from("tiny")));
  assert.equal(stub.ok, false);
});
