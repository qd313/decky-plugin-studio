declare module "pngjs" {
  export class PNG {
    width: number;
    height: number;
    data: Buffer;
    constructor(options?: { width?: number; height?: number; filterType?: number });
    static sync: {
      read(buffer: Buffer): PNG;
      write(png: PNG): Buffer;
    };
  }
}

declare module "pixelmatch" {
  export default function pixelmatch(
    img1: Buffer,
    img2: Buffer,
    output: Buffer,
    width: number,
    height: number,
    options?: { threshold?: number }
  ): number;
}
