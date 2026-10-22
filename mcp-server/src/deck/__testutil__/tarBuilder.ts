/**
 * A minimal tar writer for tests: real 512-byte headers with real checksums, so
 * the archive check has something genuine to read (and to find damaged).
 * Not a *.test.ts file on purpose; the runner would try to run it.
 */

function octal(n: number, width: number): string {
  return n.toString(8).padStart(width - 1, "0") + "\0";
}

export function tarEntry(name: string, data: Buffer, type = "0"): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, "latin1");
  h.write(octal(0o644, 8), 100, "latin1");
  h.write(octal(0, 8), 108, "latin1");
  h.write(octal(0, 8), 116, "latin1");
  h.write(octal(data.length, 12), 124, "latin1");
  h.write(octal(1_700_000_000, 12), 136, "latin1");
  h.write("        ", 148, "latin1");
  h.write(type, 156, "latin1");
  h.write("ustar\0" + "00", 257, "latin1");
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "latin1");
  const pad = (512 - (data.length % 512)) % 512;
  return Buffer.concat([h, data, Buffer.alloc(pad)]);
}

/** A whole archive: the entries, then the two zero blocks tar ends with. */
export function makeTar(files: Array<{ name: string; data: Buffer }>): Buffer {
  return Buffer.concat([
    ...files.map((f) => tarEntry(f.name, f.data)),
    Buffer.alloc(1024),
  ]);
}
