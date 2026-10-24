/**
 * One driving call at a time per machine, in this process (plan 11, lane D).
 *
 * The lease (deck/lease.ts) is per SESSION: it keeps a second session off a
 * machine, but two calls in flight from the SAME session both hold it, and
 * both reach the controller bridge's serial port at once (bonsAI's device log,
 * 2026-09-26: "two button presses sent at once clash on the controller
 * bridge's own port"). This queue closes that gap. A second driving call on a
 * machine WAITS, first in first out, for the one ahead of it -- up to its own
 * deadline -- rather than racing it to the port.
 *
 * Keyed by machine NAME, so a call on a stand-in never waits behind one on the
 * Deck. Reads never come here.
 */

export interface QueueSlot {
  /** How long this call waited for the calls ahead of it. 0 when nothing was ahead. */
  waitedMs: number;
  /** True when another call was in flight (or queued) when this one arrived. */
  queued: boolean;
  /** The tool this call waited behind, when it waited. */
  waitedBehind: string | null;
  /** Hand the machine to the next call in line. Idempotent. */
  release(): void;
}

/** A queued call whose own deadline passed before the call ahead of it finished. */
export class QueueWaitTimeoutError extends Error {
  constructor(
    readonly tool: string,
    readonly machine: string,
    readonly waitedMs: number,
    readonly behind: string,
  ) {
    super(
      `${tool} waited ${waitedMs} ms for ${behind} to finish on machine "${machine}" and its own ` +
        "deadline passed before it could start. Nothing was sent by this call. Only one driving " +
        "call runs per machine at a time; let the earlier call finish (or pass a larger deadlineMs) " +
        "and call again.",
    );
    this.name = "QueueWaitTimeoutError";
  }
}

interface Waiter {
  tool: string;
  start: () => void;
}

interface Lane {
  /** The tool holding the machine right now. */
  running: string;
  waiters: Waiter[];
}

export class MachineCallQueue {
  private readonly lanes = new Map<string, Lane>();

  /** What is driving `machine` right now, if anything. */
  runningOn(machine: string): string | null {
    return this.lanes.get(machine)?.running ?? null;
  }

  /** How many calls are waiting behind the running one on `machine`. */
  waitingOn(machine: string): number {
    return this.lanes.get(machine)?.waiters.length ?? 0;
  }

  /**
   * Take `machine` for `tool`. Resolves at once when nothing is driving it;
   * otherwise waits its turn. If `timeoutMs` passes first the call leaves the
   * line (nobody is handed a slot it will never use) and this rejects with
   * QueueWaitTimeoutError.
   */
  acquire(machine: string, tool: string, timeoutMs: number): Promise<QueueSlot> {
    const t0 = Date.now();
    const lane = this.lanes.get(machine);
    if (!lane) {
      this.lanes.set(machine, { running: tool, waiters: [] });
      return Promise.resolve(this.slot(machine, 0, false, null));
    }
    const behind = lane.waiters.length ? lane.waiters[lane.waiters.length - 1].tool : lane.running;
    return new Promise<QueueSlot>((resolve, reject) => {
      const waiter: Waiter = {
        tool,
        start: () => {
          clearTimeout(timer);
          resolve(this.slot(machine, Date.now() - t0, true, behind));
        },
      };
      const timer = setTimeout(() => {
        const i = lane.waiters.indexOf(waiter);
        if (i >= 0) lane.waiters.splice(i, 1);
        reject(new QueueWaitTimeoutError(tool, machine, Date.now() - t0, lane.running));
      }, Math.max(0, timeoutMs));
      timer.unref?.();
      lane.waiters.push(waiter);
    });
  }

  private slot(machine: string, waitedMs: number, queued: boolean, waitedBehind: string | null): QueueSlot {
    let released = false;
    return {
      waitedMs,
      queued,
      waitedBehind,
      release: () => {
        if (released) return;
        released = true;
        const lane = this.lanes.get(machine);
        if (!lane) return;
        const next = lane.waiters.shift();
        if (!next) {
          this.lanes.delete(machine);
          return;
        }
        lane.running = next.tool;
        next.start();
      },
    };
  }
}
