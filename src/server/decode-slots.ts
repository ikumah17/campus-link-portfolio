import "server-only";

// SEC-011: many users together could otherwise start any number of sharp decodes at once in one process. At most
// MAX_ACTIVE_DECODES run; up to MAX_WAITING_DECODES more wait in arrival order for at most DECODE_WAIT_MS each, and
// anything else is refused. In-memory and per process: it does not limit decodes across server instances.
export const MAX_ACTIVE_DECODES = 2;
export const MAX_WAITING_DECODES = 4;
export const DECODE_WAIT_MS = 10_000;

export type Release = () => void;
export type DecodeTimer = { set(run: () => void, ms: number): unknown; clear(handle: unknown): void };
export type DecodeSlots = { acquire(): Promise<Release | null>; active(): number; waiting(): number };
type Options = { maxActive?: number; maxWaiting?: number; waitMs?: number; timer?: DecodeTimer };
type Waiter = { grant(release: Release): void; handle: unknown };

const realTimer: DecodeTimer = { set: (run, ms) => setTimeout(run, ms), clear: (handle) => clearTimeout(handle as NodeJS.Timeout) };

export function createDecodeSlots({ maxActive = MAX_ACTIVE_DECODES, maxWaiting = MAX_WAITING_DECODES,
  waitMs = DECODE_WAIT_MS, timer = realTimer }: Options = {}): DecodeSlots {
  let active = 0;
  const queue: Waiter[] = [];

  // Each release runs once: a second call is ignored, so a slot is never freed twice.
  function releaser(): Release {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const next = queue.shift();
      if (next) {
        // The slot passes straight to the oldest waiter; its timeout can no longer fire.
        timer.clear(next.handle);
        next.grant(releaser());
      } else {
        active -= 1;
      }
    };
  }

  return {
    acquire() {
      if (active < maxActive) {
        active += 1;
        return Promise.resolve(releaser());
      }
      if (queue.length >= maxWaiting) return Promise.resolve(null);
      return new Promise<Release | null>((resolve) => {
        const waiter: Waiter = { grant: resolve, handle: undefined };
        waiter.handle = timer.set(() => {
          // A waiter past its time leaves the queue, so it is never handed a slot later.
          const index = queue.indexOf(waiter);
          if (index === -1) return;
          queue.splice(index, 1);
          resolve(null);
        }, waitMs);
        queue.push(waiter);
      });
    },
    active: () => active,
    waiting: () => queue.length,
  };
}

export const photoDecodeSlots = createDecodeSlots();
