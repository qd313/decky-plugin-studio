/**
 * How it works: remembers, inside this tool server, that a plugin_loader
 * restart was just issued for a machine, so a later deck_openPlugin knows the
 * Deck's debugger may still be rebuilding Steam's pages.
 *
 * The reload tool and the open tool are separate calls. After a deploy the
 * open tool is helped by the deploy waiting for the loader before it returns;
 * that wait only proves SOME Steam page is listed, not that the Quick Access
 * page is back and readable. After a reload that gap showed up on the Deck
 * (2026-09-26, 2026-10-01, 2026-10-11): the open tool failed twice and worked
 * on the third call. This note carries "a restart just happened" across the
 * two calls so the open tool can wait for the Quick Access page itself.
 *
 * Memory only, per machine. A tool server that restarts forgets it, which
 * costs nothing worse than the old behaviour.
 */
import { currentMachineIfAny } from "../machines.js";

/** How long after a restart the open tool still treats the Deck as rebuilding. */
export const RESTART_WINDOW_MS = 120_000;

const restartedAt = new Map<string, number>();

const keyOf = (machine?: string): string => machine ?? currentMachineIfAny()?.name ?? "default";

/** Record that a loader restart was just issued. */
export function noteLoaderRestart(machine?: string, now: number = Date.now()): void {
  restartedAt.set(keyOf(machine), now);
}

/** Milliseconds since the last noted restart, or null when none is recent. */
export function msSinceLoaderRestart(machine?: string, now: number = Date.now()): number | null {
  const at = restartedAt.get(keyOf(machine));
  if (at === undefined) return null;
  const age = now - at;
  return age >= 0 && age <= RESTART_WINDOW_MS ? age : null;
}

/** Forget the note: the Quick Access page has been seen readable since. */
export function clearLoaderRestart(machine?: string): void {
  restartedAt.delete(keyOf(machine));
}
