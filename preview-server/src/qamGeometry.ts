/**
 * Canonical Steam Deck / QAM geometry.
 *
 * The preview used to let plugin content fill whatever width the VS Code panel
 * happened to be, which hides clipping and overflow bugs that only appear inside
 * the real ~400px flyout. These constants pin the preview to device geometry.
 *
 * Mirrored in two places that cannot import TypeScript:
 *   - preview-server/src/styles/tokens.css  (--decky-stage-w/h, --decky-qam-w)
 *   - preview-server/sandbox-host.html      (viewport meta width)
 * Change all three together.
 *
 * RECALIBRATION: QAM_WIDTH is the one number here that is an estimate rather
 * than a spec. Deck native resolution (1280x800) is fixed, but the flyout width
 * should be measured against a real device rather than trusted. To do that:
 *   1. `deck.captureScreenshot` with the QAM open
 *   2. measure the flyout in the resulting PNG (see the decky-screenshot-ingest skill)
 *   3. update QAM_WIDTH plus the two mirrors above
 * The previous value in sandbox-host.html was 430, which disagreed with the
 * commonly cited 400 and had no recorded source; 400 is used here pending a
 * real measurement.
 */

/** Steam Deck native panel width, in CSS px. */
export const STAGE_WIDTH = 1280;

/** Steam Deck native panel height, in CSS px. */
export const STAGE_HEIGHT = 800;

/** Quick Access Menu flyout width, in CSS px. See RECALIBRATION above. */
export const QAM_WIDTH = 400;

/** The flyout spans the full height of the panel. */
export const QAM_HEIGHT = STAGE_HEIGHT;

export const QAM_GEOMETRY = {
  stageWidth: STAGE_WIDTH,
  stageHeight: STAGE_HEIGHT,
  qamWidth: QAM_WIDTH,
  qamHeight: QAM_HEIGHT,
} as const;

export type QamGeometry = typeof QAM_GEOMETRY;
