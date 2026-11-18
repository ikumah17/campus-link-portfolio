// @vitest-environment node
// SEC-011: at most two photo decodes per process, four more waiting up to ten seconds, anything else rate_limited.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ mode: vi.fn(), user: vi.fn(), rpc: vi.fn(), reencode: vi.fn(),
  store: vi.fn(), register: vi.fn(), remove: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/backend", () => ({ backendMode: mocks.mode }));
vi.mock("@/lib/supabase/server", () => ({ createServerSupabase: mocks.user }));
vi.mock("@/server/storage/photo-image", () => ({ reencodePhoto: mocks.reencode }));
vi.mock("@/server/storage/photo-ingest", () => ({ storePhoto: mocks.store, registerPhoto: mocks.register, deleteStoredPhoto: mocks.remove }));
import { createDecodeSlots, DECODE_WAIT_MS, MAX_ACTIVE_DECODES, MAX_WAITING_DECODES, photoDecodeSlots, type Release } from "@/server/decode-slots";
import { uploadPhoto } from "@/server/photo-upload";

const userId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("decode slots", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("uses the decided limits", () => {
    expect([MAX_ACTIVE_DECODES, MAX_WAITING_DECODES, DECODE_WAIT_MS]).toEqual([2, 4, 10_000]);
  });

  it("runs at most two at once, queues four in order and refuses the seventh at once", async () => {
    const slots = createDecodeSlots();
    const order: number[] = [];
    const releases: (Release | null)[] = [];
    const pending = Array.from({ length: 7 }, (_, i) => slots.acquire().then((release) => { order.push(i); releases[i] = release; }));
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual([0, 1, 6]);
    expect(releases[6]).toBeNull();
    expect(slots.active()).toBe(2); expect(slots.waiting()).toBe(4);
    // Each release hands its slot to the oldest waiter: 2, 3, 4, then 5.
    for (let i = 0; i < 4; i += 1) {
      releases[i]!();
      await vi.advanceTimersByTimeAsync(0);
      expect(slots.active()).toBe(2);
    }
    expect(order).toEqual([0, 1, 6, 2, 3, 4, 5]);
    for (const i of [4, 5]) releases[i]!();
    expect(slots.active()).toBe(0); expect(slots.waiting()).toBe(0);
    await Promise.all(pending);
  });

  it("lets a waiter time out after ten seconds and never runs it later", async () => {
    const slots = createDecodeSlots();
    const first = await slots.acquire(); await slots.acquire();
    let late: Release | null | undefined;
    void slots.acquire().then((release) => { late = release; });
    await vi.advanceTimersByTimeAsync(DECODE_WAIT_MS - 1);
    expect(late).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(late).toBeNull(); expect(slots.waiting()).toBe(0);
    first!();
    await vi.advanceTimersByTimeAsync(DECODE_WAIT_MS);
    expect(late).toBeNull(); expect(slots.active()).toBe(1);
  });

  it("ignores a second release of the same slot", async () => {
    const slots = createDecodeSlots();
    const release = await slots.acquire(); await slots.acquire();
    release!(); release!();
    expect(slots.active()).toBe(1);
  });

  it("uses an injected clock", async () => {
    const timers: (() => void)[] = [];
    const slots = createDecodeSlots({ timer: { set: (run) => timers.push(run), clear: () => {} } });
    await slots.acquire(); await slots.acquire();
    const waiting = slots.acquire();
    timers[0]();
    expect(await waiting).toBeNull();
  });
});

describe("uploadPhoto with decode slots", () => {
  let events: string[];
  function form() {
    const data = new FormData();
    data.set("photo", new File([new Uint8Array([1, 2, 3])], "synthetic.png", { type: "image/png" }));
    return data;
  }
  beforeEach(() => {
    vi.resetAllMocks(); events = [];
    mocks.mode.mockReturnValue("supabase");
    mocks.user.mockResolvedValue({ rpc: mocks.rpc });
    mocks.rpc.mockImplementation(async (name: string) => {
      events.push(name);
      return name === "my_account" ? { data: [{ user_id: userId }], error: null } : { data: { ok: true, code: "ok", ref: null }, error: null };
    });
    mocks.store.mockImplementation(async () => { events.push("store"); return "path"; });
    mocks.register.mockImplementation(async () => ({ code: "ok", data: { ref: "x" } }));
    mocks.remove.mockResolvedValue(undefined);
  });
  afterEach(() => { vi.restoreAllMocks(); expect(photoDecodeSlots.active()).toBe(0); expect(photoDecodeSlots.waiting()).toBe(0); });

  it("answers rate_limited when busy without a reservation or a decode", async () => {
    const acquire = vi.spyOn(photoDecodeSlots, "acquire").mockResolvedValue(null);
    expect(await uploadPhoto(form())).toEqual({ status: "rate_limited" });
    expect(acquire).toHaveBeenCalledOnce();
    expect(events).toEqual(["my_account"]);
    expect(mocks.reencode).not.toHaveBeenCalled(); expect(mocks.store).not.toHaveBeenCalled();
  });

  it("frees the slot when the decode throws", async () => {
    mocks.reencode.mockRejectedValue(new Error("bad image"));
    expect(await uploadPhoto(form())).toEqual({ status: "invalid" });
    expect(events).toEqual(["my_account", "reserve_photo_upload"]);
  });

  it("frees the slot when the reservation is refused", async () => {
    mocks.rpc.mockImplementation(async (name: string) => name === "my_account"
      ? { data: [{ user_id: userId }], error: null } : { data: { ok: false, code: "rate_limited" }, error: null });
    expect(await uploadPhoto(form())).toEqual({ status: "rate_limited" });
  });

  it("frees the slot before the Storage write", async () => {
    mocks.reencode.mockImplementation(async () => { events.push("reencode"); return Buffer.from("webp"); });
    mocks.store.mockImplementation(async () => { events.push(`store:${photoDecodeSlots.active()}`); return "path"; });
    await uploadPhoto(form());
    expect(events).toEqual(["my_account", "reserve_photo_upload", "reencode", "store:0"]);
  });

  it("runs no more than two decodes at once across concurrent uploads", async () => {
    let running = 0, peak = 0;
    const gates: (() => void)[] = [];
    mocks.reencode.mockImplementation(async () => {
      running += 1; peak = Math.max(peak, running);
      await new Promise<void>((resolve) => gates.push(resolve));
      running -= 1;
      return Buffer.from("webp");
    });
    const uploads = Array.from({ length: 7 }, () => uploadPhoto(form()));
    for (let i = 0; i < 20; i += 1) await settled();
    expect(running).toBe(2);
    expect(events.filter((e) => e === "reserve_photo_upload")).toHaveLength(2);
    while (gates.length) { gates.shift()!(); for (let i = 0; i < 20; i += 1) await settled(); }
    const results = await Promise.all(uploads);
    expect(peak).toBe(2);
    expect(results.filter((r) => r.status === "rate_limited")).toHaveLength(1);
    expect(mocks.reencode).toHaveBeenCalledTimes(6);
    expect(events.filter((e) => e === "reserve_photo_upload")).toHaveLength(6);
  });
});
