/**
 * How it works: runs deck_openPlugin once and, when that first try failed in a
 * way a second look can cure, runs it exactly once more inside the same call,
 * then says in the result that it did.
 *
 * Why it exists. After a plugin reload the first deck_openPlugin failed in 3 of
 * 3 rounds on the Deck night of 2026-10-12 and the next call always worked:
 * once on the connection to Steam's debugger (a reset, nothing pressed), twice
 * because the open chord went out and no Quick Access pane appeared. Two fixes
 * that made the tool wait longer (59d1698: for the Quick Access page after a
 * reload; 28e7325: 3 s of reading after the chord) were loaded on the Deck and
 * did not cure it, so waiting inside one try is not the whole answer; what
 * always worked was "read again, then act on what you read". The second try is
 * exactly that, and it is safe because openPluginDriven reads the menu's own
 * state first and presses the toggle chord only when the Quick Access page says
 * the menu is shut, so a menu that did open late is left alone.
 *
 * What earns a second try (isRetryableOpenFailure): nothing was pressed, or the
 * only press was the open chord. A half-finished walk through the Decky list is
 * not repeated blindly, and a stopped rig is never retried.
 *
 * Used for: the deck_openPlugin tool entry in index.ts.
 * Solves: the first-try failure after a plugin reload (plan 93 lane R, QA row
 * P89-RIG-OPEN-AFTER-RELOAD).
 * Does not: retry more than once, wait for the Deck beyond one short pause, or
 * change what a single try does (that stays in openPlugin.ts).
 */
import { openPluginDriven, type OpenPluginOptions, type OpenPluginResult } from "./openPlugin.js";

/** The pause between the two tries: long enough for a debugger that just reset to come back. */
const DEFAULT_RETRY_DELAY_MS = 2500;

export interface OpenPluginRetryOptions extends OpenPluginOptions {
  /** Pause between the first failure and the second try. Tests shorten it. */
  retryDelayMs?: number;
  /** Test seam: called after a first try fails and before the second starts. */
  onFirstAttemptFailed?: (first: OpenPluginResult) => void;
}

/** Stages whose single press is the QAM toggle chord (see openPlugin.ts). */
const CHORD_STAGES = new Set(["open-qam", "open-qam-blind"]);

/**
 * Should a failed try be repeated? Only when repeating cannot repeat a state
 * change: no press went out at all, or the one press was the open chord (and the
 * second try re-reads the menu before it presses anything).
 */
export function isRetryableOpenFailure(r: OpenPluginResult): boolean {
  if (r.ok || r.stopped) return false;
  const pressing = r.stages.filter((s) => (s.presses ?? 0) > 0);
  if (pressing.length === 0) return true;
  return pressing.length === 1 && CHORD_STAGES.has(pressing[0].stage) && (pressing[0].presses ?? 0) === 1;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function openPluginWithRetry(opts: OpenPluginRetryOptions): Promise<OpenPluginResult> {
  const { retryDelayMs, onFirstAttemptFailed, ...single } = opts;
  const first = await openPluginDriven(single);
  if (first.ok || !isRetryableOpenFailure(first)) return first;

  onFirstAttemptFailed?.(first);
  const firstReason = first.reason ?? first.summary;
  await sleep(retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
  const second = await openPluginDriven(single);

  const note = {
    attempts: 2,
    firstReason,
    firstSummary: first.summary,
    firstStages: first.stages,
  };
  return {
    ...second,
    // Every press of the call, both tries, stays on the record.
    stages: [
      ...first.stages.map((s) => ({ ...s, stage: `try1:${s.stage}` })),
      ...second.stages.map((s) => ({ ...s, stage: `try2:${s.stage}` })),
    ],
    retried: note,
    summary: second.ok
      ? `${second.summary}. The first try failed (${firstReason}), so the tool read the Deck again and tried a second time; the second try worked`
      : `${second.summary}. A first try also failed (${firstReason}); both tries are in the stages`,
  };
}
