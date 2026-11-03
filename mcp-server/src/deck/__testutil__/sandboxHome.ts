/**
 * Point the config directory at a temp dir for the rest of this test file.
 *
 * getConfigDir() derives from os.homedir(), which reads USERPROFILE/HOME at
 * call time, so setting them at the top of a test file is enough even with
 * static imports (killswitch.test.ts and lease.test.ts do the same by hand).
 * Needed by every suite that reaches loaderRestart.ts since the restart note
 * became a file (plan 12 lane A): without it a test would write a "the Deck
 * just restarted" note into the real config dir, where a live server reads it,
 * and would read a real note left by the maintainer's last reload.
 *
 * Not a *.test.ts file on purpose -- the runner discovers those.
 */
import { after } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function sandboxHome(prefix: string): string {
  const real = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.USERPROFILE = dir;
  process.env.HOME = dir;
  after(() => {
    if (real.USERPROFILE === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = real.USERPROFILE;
    if (real.HOME === undefined) delete process.env.HOME;
    else process.env.HOME = real.HOME;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}
