/**
 * Optional on-preview debug ring buffer for focus/layout debugging.
 * Enable in Developer settings or call previewDebugLog from hot paths.
 */

const MAX = 24;

export type PreviewDebugEntry = {
  ts: number;
  location: string;
  message: string;
  data?: Record<string, unknown>;
};

export function previewDebugLog(
  location: string,
  message: string,
  data?: Record<string, unknown>
): void {
  const w = window as Window & { __deckyPreviewDebug?: PreviewDebugEntry[] };
  if (!w.__deckyPreviewDebug) w.__deckyPreviewDebug = [];
  w.__deckyPreviewDebug.push({ ts: Date.now(), location, message, data });
  if (w.__deckyPreviewDebug.length > MAX) w.__deckyPreviewDebug.shift();
  try {
    console.error("[decky-preview-debug]", message, data ?? "");
  } catch {
    /* ignore */
  }
}

export function readPreviewDebugRing(): PreviewDebugEntry[] {
  return [...((window as Window & { __deckyPreviewDebug?: PreviewDebugEntry[] }).__deckyPreviewDebug ?? [])];
}
