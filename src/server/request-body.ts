import "server-only";

// REFACTOR-001: the body bounds of the routes that run outside the proxy (POST /api/photos and /api/mobile/*), so
// each route bounds its own body. One copy, so the web and the app cannot drift apart (FIX-002, FIX-004).
// Every JSON answer of these routes allows nothing and is never stored (docs/42 §2.2, SEC-015).
export const NO_STORE_HEADERS = { "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'" };

/**
 * FIX-009: the least progress a body must make. In every window of windowMs at least minBytes more must arrive, or
 * the read ends as "slow"; a body that completes needs no more windows.
 */
export type BodyProgress = { windowMs: number; minBytes: number };

/**
 * Reads at most maxBytes within timeoutMs; "too_large" when the body is larger, whatever Content-Length claimed, and
 * "timeout" when it is not complete in time. With a progress option (FIX-009) it also ends as "slow" when a window
 * brings too few bytes, and as "aborted" when the client goes away (the request's signal aborts or the stream fails);
 * without one, a failing stream throws, as before.
 */
export function boundedBody(request: Request, maxBytes: number, timeoutMs: number): Promise<Uint8Array<ArrayBuffer> | "too_large" | "timeout">;
export function boundedBody(request: Request, maxBytes: number, timeoutMs: number, progress: BodyProgress):
  Promise<Uint8Array<ArrayBuffer> | "too_large" | "timeout" | "slow" | "aborted">;
export async function boundedBody(request: Request, maxBytes: number, timeoutMs: number, progress?: BodyProgress):
  Promise<Uint8Array<ArrayBuffer> | "too_large" | "timeout" | "slow" | "aborted"> {
  if (!request.body) return new Uint8Array(0);
  if (progress && request.signal.aborted) return "aborted";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let handle: ReturnType<typeof setTimeout> | undefined;
  let windowHandle: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const deadline = new Promise<"timeout">((resolve) => { handle = setTimeout(() => resolve("timeout"), timeoutMs); });
  const stops: Promise<"timeout" | "slow" | "aborted">[] = [deadline];
  if (progress) {
    stops.push(new Promise<"slow">((resolve) => {
      let mark = 0;
      const check = () => {
        if (total - mark < progress.minBytes) return resolve("slow");
        mark = total;
        windowHandle = setTimeout(check, progress.windowMs);
      };
      windowHandle = setTimeout(check, progress.windowMs);
    }));
    stops.push(new Promise<"aborted">((resolve) => {
      onAbort = () => resolve("aborted");
      request.signal.addEventListener("abort", onAbort, { once: true });
    }));
  }
  try {
    for (;;) {
      const read = reader.read();
      // A read still pending at the deadline settles after the cancel; its result is unused.
      read.catch(() => {});
      let next: Awaited<typeof read> | "timeout" | "slow" | "aborted";
      try {
        next = await Promise.race([read, ...stops]);
      } catch (error) {
        // A failing stream is a client that went away; without a progress option the caller sees the error.
        if (!progress) throw error;
        void reader.cancel().catch(() => {});
        return "aborted";
      }
      if (typeof next === "string") {
        void reader.cancel().catch(() => {});
        return next;
      }
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return "too_large";
      }
      chunks.push(next.value);
    }
  } finally {
    clearTimeout(handle);
    clearTimeout(windowHandle);
    if (onAbort) request.signal.removeEventListener("abort", onAbort);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** "length" for a missing or malformed Content-Length, "too_large" for a declared length over the bound. */
export function declaredLength(request: Request, maxBytes: number): "ok" | "length" | "too_large" {
  const declared = request.headers.get("content-length");
  if (declared === null || !/^\d{1,10}$/.test(declared)) return "length";
  return Number(declared) > maxBytes ? "too_large" : "ok";
}

export function mediaType(request: Request): string {
  return (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
}
