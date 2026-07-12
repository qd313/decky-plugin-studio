import fs from "fs";
import path from "path";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import { getWorkspaceRoot } from "../config.js";
import { previewCaptureScreenshot } from "../tools/preview.js";

export async function previewCompareScreenshot(params: {
  name: string;
  selector?: string;
  threshold?: number;
  updateBaseline?: boolean;
}): Promise<{
  match: boolean;
  diffPercent: number;
  path: string;
  baselinePath: string;
  diffPath?: string;
  updated?: boolean;
}> {
  const workspace = getWorkspaceRoot();
  const name = params.name.replace(/[^a-zA-Z0-9_-]/g, "_");
  const baselineDir = path.join(workspace, "tests", "preview-baselines");
  const baselinePath = path.join(baselineDir, `${name}.png`);
  const diffDir = path.join(workspace, "screenshots", "preview", "diffs");
  fs.mkdirSync(baselineDir, { recursive: true });
  fs.mkdirSync(diffDir, { recursive: true });

  const capture = await previewCaptureScreenshot({ selector: params.selector });
  if (capture.error || !capture.path || !fs.existsSync(capture.path)) {
    throw new Error(capture.error ?? "captureScreenshot failed");
  }
  const capturePath = capture.path;

  if (params.updateBaseline || !fs.existsSync(baselinePath)) {
    fs.copyFileSync(capturePath, baselinePath);
    return {
      match: true,
      diffPercent: 0,
      path: capturePath,
      baselinePath,
      updated: true,
    };
  }

  const img1 = PNG.sync.read(fs.readFileSync(baselinePath));
  const img2 = PNG.sync.read(fs.readFileSync(capturePath));

  if (img1.width !== img2.width || img1.height !== img2.height) {
    const diffPath = path.join(diffDir, `${name}-size-mismatch.png`);
    fs.copyFileSync(capturePath, diffPath);
    return {
      match: false,
      diffPercent: 100,
      path: capturePath,
      baselinePath,
      diffPath,
    };
  }

  const { width, height } = img1;
  const diffPng = new PNG({ width, height });
  const threshold = params.threshold ?? 1.5;
  const diffPixels = pixelmatch(img1.data, img2.data, diffPng.data, width, height, {
    threshold: 0.1,
  });
  const diffPercent = (diffPixels / (width * height)) * 100;
  const match = diffPercent <= threshold;

  let diffPath: string | undefined;
  if (!match) {
    diffPath = path.join(diffDir, `${name}-diff.png`);
    fs.writeFileSync(diffPath, PNG.sync.write(diffPng));
  }

  return {
    match,
    diffPercent: Math.round(diffPercent * 100) / 100,
    path: capturePath,
    baselinePath,
    diffPath,
  };
}
