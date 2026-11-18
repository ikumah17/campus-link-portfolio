// @vitest-environment node
// FIX-009: the progress deadline of boundedBody and the per-user upload cooldown, without any route or network.
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ createServerSupabase: vi.fn() }));
import { boundedBody } from "@/server/request-body";
import { createUploadCooldowns, MAX_COOLDOWN_ENTRIES, UPLOAD_COOLDOWN_MS } from "@/server/photo-upload";
import { BODY_PROGRESS_MIN_BYTES, BODY_PROGRESS_WINDOW_MS, BODY_READ_MS } from "@/server/photo-route-core";

const MiB = 1_048_576;
const progress = { windowMs: BODY_PROGRESS_WINDOW_MS, minBytes: BODY_PROGRESS_MIN_BYTES };
afterEach(() => { vi.useRealTimers(); });

function stream(signal?: AbortSignal) {
  const state = { cancelled: false };
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; }, cancel() { state.cancelled = true; } }, { highWaterMark: 0 });
  const request = new Request("http://campus.test/", { method: "POST", body, duplex: "half", signal } as RequestInit);
  return { request, state, send: (n: number) => controller.enqueue(new Uint8Array(n)), close: () => controller.close(),
    fail: () => controller.error(new Error("gone")) };
}

describe("boundedBody progress deadline", () => {
  it("uses 64 KiB per 5-second window", () => {
    expect([BODY_PROGRESS_WINDOW_MS, BODY_PROGRESS_MIN_BYTES, BODY_READ_MS]).toEqual([5_000, 65_536, 30_000]);
  });
  it("ends a body that brings too few bytes in a window as slow and cancels it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const body = stream();
    const read = boundedBody(body.request, 8 * MiB, BODY_READ_MS, progress);
    body.send(BODY_PROGRESS_MIN_BYTES);
    await vi.advanceTimersByTimeAsync(5_000);
    body.send(BODY_PROGRESS_MIN_BYTES - 1);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(read).resolves.toBe("slow");
    expect(body.state.cancelled).toBe(true); expect(vi.getTimerCount()).toBe(0);
  });
  it("passes an 8 MiB body at a steady 320 KiB/s with a 3-second stall", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const body = stream();
    const read = boundedBody(body.request, 8 * MiB, BODY_READ_MS, progress);
    for (let sent = 0; sent < 8 * MiB; sent += 32 * 1024) {
      body.send(32 * 1024);
      await vi.advanceTimersByTimeAsync(sent === 4 * MiB ? 3_100 : 100);
    }
    body.close();
    const bytes = await read;
    expect(bytes).toBeInstanceOf(Uint8Array); expect((bytes as Uint8Array).byteLength).toBe(8 * MiB);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("ends as aborted when the request's signal aborts or the stream fails", async () => {
    const abort = new AbortController();
    const first = stream(abort.signal);
    const read = boundedBody(first.request, MiB, BODY_READ_MS, progress);
    first.send(10);
    abort.abort();
    await expect(read).resolves.toBe("aborted");
    const second = stream();
    const failing = boundedBody(second.request, MiB, BODY_READ_MS, progress);
    second.fail();
    await expect(failing).resolves.toBe("aborted");
  });
  it("keeps the old behavior without a progress option", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const slow = stream();
    const read = boundedBody(slow.request, MiB, BODY_READ_MS);
    let settled = false;
    void read.finally(() => { settled = true; });
    slow.send(1);
    await vi.advanceTimersByTimeAsync(BODY_READ_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(read).resolves.toBe("timeout");
    vi.useRealTimers();
    const failing = stream();
    const thrown = boundedBody(failing.request, MiB, BODY_READ_MS);
    failing.fail();
    await expect(thrown).rejects.toThrow("gone");
  });
});

describe("upload cooldowns", () => {
  it("refuses a user for 60 seconds and only that user", () => {
    let now = 1_000;
    const cooldowns = createUploadCooldowns({ now: () => now });
    expect(UPLOAD_COOLDOWN_MS).toBe(60_000);
    cooldowns.start("a");
    expect([cooldowns.active("a"), cooldowns.active("b")]).toEqual([true, false]);
    now += UPLOAD_COOLDOWN_MS - 1;
    expect(cooldowns.active("a")).toBe(true);
    now += 1;
    expect(cooldowns.active("a")).toBe(false); expect(cooldowns.size()).toBe(0);
  });
  it("stays bounded: expired entries go first, then the oldest", () => {
    let now = 0;
    const cooldowns = createUploadCooldowns({ ms: 100, maxEntries: 3, now: () => now });
    cooldowns.start("a"); now = 50; cooldowns.start("b"); cooldowns.start("c");
    now = 100; cooldowns.start("d");
    // "a" expired at 100 and was removed; the others are live.
    expect(cooldowns.size()).toBe(3); expect(["b", "c", "d"].map((id) => cooldowns.active(id))).toEqual([true, true, true]);
    cooldowns.start("e");
    expect(cooldowns.size()).toBe(3); expect(cooldowns.active("b")).toBe(false); expect(cooldowns.active("e")).toBe(true);
    // A restart moves the user to the newest place.
    cooldowns.start("c"); cooldowns.start("f");
    expect(cooldowns.active("c")).toBe(true); expect(cooldowns.active("d")).toBe(false);
    expect(MAX_COOLDOWN_ENTRIES).toBe(10_000);
  });
  it("never grows past the cap under many distinct users", () => {
    const cooldowns = createUploadCooldowns({ maxEntries: 50, now: () => 0 });
    for (let n = 0; n < 1_000; n += 1) cooldowns.start(`user-${n}`);
    expect(cooldowns.size()).toBe(50); expect(cooldowns.active("user-999")).toBe(true); expect(cooldowns.active("user-0")).toBe(false);
  });
});
