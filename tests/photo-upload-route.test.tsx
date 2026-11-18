// @vitest-environment node
// SEC-007: POST /api/photos replaces the uploadPhoto Server Action. Same-origin rule, bounded read, then the shared module.
// FIX-002: the account check, the per-user lock and a body slot all pass before any body byte is read.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import sharp from "sharp";
const mocks = vi.hoisted(() => ({ mode: vi.fn(), user: vi.fn(), userRpc: vi.fn(), service: vi.fn(),
  serviceRpc: vi.fn(), from: vi.fn(), upload: vi.fn(), remove: vi.fn(), uuid: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/backend", () => ({ backendMode: mocks.mode }));
vi.mock("@/lib/supabase/server", () => ({ createServerSupabase: mocks.user }));
vi.mock("@supabase/supabase-js", () => ({ createClient: mocks.service }));
vi.mock("@/lib/supabase/config", () => ({ supabasePublicConfig: () => ({ url: "https://synthetic.supabase.co" }) }));
vi.mock("node:crypto", async (importOriginal) => ({ ...await importOriginal<typeof import("node:crypto")>(), randomUUID: mocks.uuid }));
import * as images from "@/server/storage/photo-image";
import * as shared from "@/server/photo-upload";
import * as route from "@/app/api/photos/route";

const userId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const photoId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const privateMessage = "private DB or storage message";
const BOUND = 4_194_304 + 65_536;
const CSP = "default-src 'none'; frame-ancestors 'none'";
const ok = (ref: string | null = null) => ({ data: { ok: true, code: "ok", ref }, error: null });
const account = () => ({ data: [{ user_id: userId }], error: null });
let png: Buffer;
let events: string[];
let fetchSpy: ReturnType<typeof vi.spyOn>;
let decode: MockInstance<typeof images.reencodePhoto>;
let sharedUpload: MockInstance<typeof shared.uploadPhoto>;
beforeAll(async () => { png = await sharp({ create: { width: 20, height: 10, channels: 3, background: "white" } }).png().toBuffer(); });
beforeEach(() => {
  vi.resetAllMocks(); events = []; shared.photoUploadCooldowns.clear();
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "sb_secret_fake");
  fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network forbidden"));
  mocks.mode.mockReturnValue("supabase"); mocks.uuid.mockReturnValue(photoId);
  mocks.user.mockResolvedValue({ rpc: mocks.userRpc });
  mocks.userRpc.mockImplementation(async (name: string) => { events.push(name); return name === "my_account" ? account() : ok(photoId); });
  mocks.service.mockReturnValue({ storage: { from: mocks.from }, rpc: mocks.serviceRpc });
  mocks.from.mockReturnValue({ upload: mocks.upload, remove: mocks.remove });
  mocks.upload.mockImplementation(async () => { events.push("upload"); return { error: null }; });
  mocks.serviceRpc.mockImplementation(async () => { events.push("register"); return ok(photoId); });
  mocks.remove.mockImplementation(async () => { events.push("delete"); return { error: null }; });
  const realReencode = images.reencodePhoto;
  decode = vi.spyOn(images, "reencodePhoto").mockImplementation(async (bytes) => { events.push("reencode"); return realReencode(bytes); });
  const realUpload = shared.uploadPhoto;
  sharedUpload = vi.spyOn(shared, "uploadPhoto").mockImplementation((data, session) => realUpload(data, session));
});
afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers();
  // Every outcome frees this user's lock and the body slot.
  expect(shared.photoUploadLocks.held()).toBe(0); expect(shared.photoBodySlots.active()).toBe(0);
});

async function multipart(bytes: Uint8Array = png) {
  const data = new FormData();
  data.set("photo", new File([new Uint8Array(bytes)], "synthetic.png", { type: "image/png" }));
  const encoded = new Response(data);
  return { body: new Uint8Array(await encoded.arrayBuffer()), type: encoded.headers.get("content-type")! };
}
type Options = { body?: BodyInit; type?: string; length?: string; headers?: Record<string, string | undefined> };
function post({ body, type, length, headers = {} }: Options) {
  const all: Record<string, string | undefined> = {
    host: "campus.test", origin: "http://campus.test", "sec-fetch-site": "same-origin",
    "content-type": type, "content-length": length, ...headers,
  };
  const init: RequestInit & { duplex?: "half" } = { method: "POST", body, duplex: "half",
    headers: Object.fromEntries(Object.entries(all).filter((entry): entry is [string, string] => entry[1] !== undefined)) };
  return new Request("http://campus.test/api/photos", init);
}
async function valid(headers: Record<string, string | undefined> = {}) {
  const { body, type } = await multipart();
  return post({ body, type, length: String(body.byteLength), headers });
}
async function expectAnswer(response: Response, http: number, status: string) {
  expect(response.status).toBe(http);
  expect(response.headers.get("cache-control")).toBe("no-store");
  // SEC-015: the proxy no longer runs for this path, so the route sets its own CSP.
  expect(response.headers.get("content-security-policy")).toBe(CSP);
  const body = await response.json();
  expect(body).toEqual({ status });
  const serialized = JSON.stringify(body);
  for (const value of [privateMessage, userId, photoId, "synthetic.png"]) expect(serialized).not.toContain(value);
}
function nothingRan() {
  expect(sharedUpload).not.toHaveBeenCalled(); expect(mocks.user).not.toHaveBeenCalled();
  expect(decode).not.toHaveBeenCalled(); expect(mocks.service).not.toHaveBeenCalled();
}
/** Only the account check ran: the body was refused before the shared module. */
function onlyAccountRan() {
  expect(sharedUpload).not.toHaveBeenCalled(); expect(events).toEqual(["my_account"]);
  expect(decode).not.toHaveBeenCalled(); expect(mocks.service).not.toHaveBeenCalled();
}
/** A body whose bytes are handed out only when the test says so; it records whether anything pulled it. */
function heldBody() {
  const state = { pulled: false, cancelled: false };
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let markPulled!: () => void;
  const started = new Promise<void>((resolve) => { markPulled = resolve; });
  const body = new ReadableStream<Uint8Array>({
    start(c) { controller = c; },
    pull() { state.pulled = true; markPulled(); },
    cancel() { state.cancelled = true; },
  }, { highWaterMark: 0 });
  return { body, state, started,
    send(bytes: Uint8Array) { controller.enqueue(bytes); },
    finish(bytes: Uint8Array) { controller.enqueue(bytes); controller.close(); },
    fail() { controller.error(new Error(privateMessage)); } };
}
async function heldRequest() {
  const held = heldBody();
  const { body, type } = await multipart();
  return { ...held, bytes: body, request: post({ body: held.body, type, length: String(body.byteLength) }) };
}
const otherUser = (n: number) => `cccccccc-cccc-4ccc-8ccc-${String(n).padStart(12, "0")}`;

describe("same-origin rule", () => {
  it("accepts a same-origin upload and stores it through the shared module", async () => {
    await expectAnswer(await route.POST(await valid()), 200, "ok");
    expect(sharedUpload).toHaveBeenCalledOnce();
    // The route's account check is passed in, so the shared module runs no second one.
    expect(sharedUpload.mock.calls[0][1]).toMatchObject({ status: "ok", userId });
    const file = sharedUpload.mock.calls[0][0].get("photo") as File;
    expect(file).toBeInstanceOf(File); expect(Buffer.from(await file.arrayBuffer()).equals(png)).toBe(true);
    expect(events).toEqual(["my_account", "reserve_photo_upload", "reencode", "upload", "register"]);
  });
  it("accepts a same-origin request without Sec-Fetch-Site and an explicit port", async () => {
    await expectAnswer(await route.POST(await valid({ "sec-fetch-site": undefined, host: "127.0.0.1:3207", origin: "http://127.0.0.1:3207" })), 200, "ok");
  });
  it.each([
    ["a missing Origin", { origin: undefined }],
    ["a null Origin", { origin: "null" }],
    ["another host", { origin: "http://evil.test" }],
    ["another port", { origin: "http://campus.test:8080" }],
    ["a subdomain", { origin: "http://evil.campus.test" }],
    ["a non-http scheme", { origin: "file://campus.test" }],
    ["an Origin with a path", { origin: "http://campus.test/" }],
    ["a missing Host", { host: undefined }],
    ["a spoofed X-Forwarded-Host", { origin: "http://evil.test", "x-forwarded-host": "evil.test" }],
    ["Sec-Fetch-Site cross-site", { "sec-fetch-site": "cross-site" }],
    ["Sec-Fetch-Site same-site", { "sec-fetch-site": "same-site" }],
    ["Sec-Fetch-Site none", { "sec-fetch-site": "none" }],
  ])("refuses %s with 403 before reading the body", async (_, headers) => {
    const request = await valid(headers);
    await expectAnswer(await route.POST(request), 403, "invalid");
    expect(request.bodyUsed).toBe(false); nothingRan();
  });
});

describe("content type and length", () => {
  it.each([["missing", undefined], ["JSON", "application/json"], ["text", "text/plain"], ["urlencoded", "application/x-www-form-urlencoded"]])(
    "refuses a %s content type with 415", async (_, type) => {
      const { body } = await multipart();
      const request = post({ body, type, length: String(body.byteLength) });
      await expectAnswer(await route.POST(request), 415, "invalid");
      expect(request.bodyUsed).toBe(false); nothingRan();
    });
  it("refuses multipart without a boundary as invalid", async () => {
    const { body } = await multipart();
    await expectAnswer(await route.POST(post({ body, type: "multipart/form-data", length: String(body.byteLength) })), 400, "invalid");
    onlyAccountRan();
  });
  it.each([["missing", undefined], ["non-numeric", "abc"], ["negative", "-1"], ["fractional", "1.5"], ["huge", "99999999999"]])(
    "refuses a %s Content-Length before reading", async (_, length) => {
      const { body, type } = await multipart();
      const request = post({ body, type, length });
      await expectAnswer(await route.POST(request), 411, "invalid");
      expect(request.bodyUsed).toBe(false); nothingRan();
    });
  it("refuses a declared length over the bound with 413 before reading", async () => {
    const { body, type } = await multipart();
    const request = post({ body, type, length: String(BOUND + 1) });
    await expectAnswer(await route.POST(request), 413, "too_large");
    expect(request.bodyUsed).toBe(false); nothingRan();
  });
  it("reads a body of exactly the bound", async () => {
    const body = new Uint8Array(BOUND);
    await expectAnswer(await route.POST(post({ body, type: "multipart/form-data; boundary=x", length: String(BOUND) })), 400, "invalid");
    onlyAccountRan();
  });
  it("shares one 4 MiB limit with the client and keeps the bound under Vercel's 4.5 MB body limit", async () => {
    const client = await import("@/lib/photo-downscale");
    expect([shared.MAX_PHOTO_BYTES, client.MAX_PHOTO_BYTES]).toEqual([4_194_304, 4_194_304]);
    expect(BOUND).toBeLessThan(4_500_000);
  });
  it("accepts a 4 MiB photo within the bound", async () => {
    const { body, type } = await multipart(new Uint8Array(4_194_304));
    expect(body.byteLength).toBeLessThanOrEqual(BOUND);
    await route.POST(post({ body, type, length: String(body.byteLength) }));
    expect(sharedUpload).toHaveBeenCalledOnce(); expect(decode).toHaveBeenCalledOnce(); expect(decode.mock.calls[0][0]).toHaveLength(4_194_304);
  });
  it("lets the shared module map a 4 MiB + 1 photo to too_large", async () => {
    const { body, type } = await multipart(new Uint8Array(4_194_305));
    expect(body.byteLength).toBeLessThanOrEqual(BOUND);
    await expectAnswer(await route.POST(post({ body, type, length: String(body.byteLength) })), 413, "too_large");
    expect(sharedUpload).toHaveBeenCalledOnce(); expect(events).toEqual(["my_account"]); expect(decode).not.toHaveBeenCalled();
  });
  it("cuts off a body larger than the bound even when Content-Length lied", async () => {
    const chunk = new Uint8Array(1_048_576);
    let pulled = 0, cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { pulled += chunk.byteLength; controller.enqueue(chunk); },
      cancel() { cancelled = true; },
    });
    const { type } = await multipart();
    await expectAnswer(await route.POST(post({ body, type, length: "100" })), 413, "too_large");
    expect(cancelled).toBe(true);
    // The stream is pulled one chunk ahead at most: never anywhere near an unbounded read.
    expect(pulled).toBeLessThanOrEqual(BOUND + 3 * chunk.byteLength);
    onlyAccountRan();
  });
});

describe("FIX-002 gate before the body", () => {
  it.each([
    ["the account check rejects the session", 401, "unauthenticated", () => mocks.userRpc.mockResolvedValue({ data: null, error: { status: 401, message: privateMessage } })],
    // SEC-015: with the proxy gone for this path, these reach the route and must still stop here.
    ["there is no session (PostgREST 401 for anon)", 401, "unauthenticated", () => mocks.userRpc.mockResolvedValue({ data: null, error: { code: "42501", message: privateMessage }, status: 401 })],
    ["the access token is stale", 401, "unauthenticated", () => mocks.userRpc.mockResolvedValue({ data: null, error: { code: "PGRST301", message: privateMessage }, status: 401 })],
    ["the account read fails", 503, "unavailable", () => mocks.userRpc.mockResolvedValue({ data: null, error: { message: privateMessage } })],
    ["the account row is malformed", 503, "unavailable", () => mocks.userRpc.mockResolvedValue({ data: [{ user_id: "x" }], error: null })],
    ["the client cannot be created", 503, "unavailable", () => mocks.user.mockRejectedValue(new Error(privateMessage))],
  ] as const)("answers at once with the body unread when %s", async (_, http, status, arrange) => {
    arrange();
    const held = await heldRequest();
    await expectAnswer(await route.POST(held.request), http, status);
    expect(held.state.pulled).toBe(false); expect(held.request.bodyUsed).toBe(false);
    expect(sharedUpload).not.toHaveBeenCalled(); expect(decode).not.toHaveBeenCalled(); expect(mocks.service).not.toHaveBeenCalled();
  });
  it("refuses a second concurrent upload by the same user with the body unread", async () => {
    const first = await heldRequest();
    const pending = route.POST(first.request);
    await first.started;
    expect(shared.photoUploadLocks.held()).toBe(1); expect(shared.photoBodySlots.active()).toBe(1);
    const second = await heldRequest();
    await expectAnswer(await route.POST(second.request), 429, "rate_limited");
    expect(second.state.pulled).toBe(false); expect(second.request.bodyUsed).toBe(false);
    // The refused request took no body slot and spent no reservation.
    expect(shared.photoBodySlots.active()).toBe(1); expect(events).toEqual(["my_account", "my_account"]);
    first.finish(first.bytes);
    await expectAnswer(await pending, 200, "ok");
    expect(events).toEqual(["my_account", "my_account", "reserve_photo_upload", "reencode", "upload", "register"]);
    // Once the first upload ends, the same user may upload again.
    await expectAnswer(await route.POST(await valid()), 200, "ok");
  });
  it("refuses a fifth concurrent body while four are being read, with the body unread", async () => {
    for (let n = 1; n <= 5; n += 1) {
      const rpc = async (name: string) => { events.push(name); return name === "my_account" ? { data: [{ user_id: otherUser(n) }], error: null } : ok(photoId); };
      mocks.user.mockResolvedValueOnce({ rpc });
    }
    const reading = await Promise.all([1, 2, 3, 4].map(() => heldRequest()));
    const pending = reading.map((held) => route.POST(held.request));
    await Promise.all(reading.map((held) => held.started));
    expect(shared.photoBodySlots.active()).toBe(4); expect(shared.photoUploadLocks.held()).toBe(4);
    const fifth = await heldRequest();
    await expectAnswer(await route.POST(fifth.request), 429, "rate_limited");
    expect(fifth.state.pulled).toBe(false); expect(fifth.request.bodyUsed).toBe(false);
    // The fifth user's lock was taken and freed again; no reservation was spent.
    expect(shared.photoUploadLocks.held()).toBe(4); expect(events.filter((name) => name !== "my_account")).toEqual([]);
    for (const held of reading) held.fail();
    for (const response of pending) await expectAnswer(await response, 400, "invalid");
    expect(decode).not.toHaveBeenCalled(); expect(mocks.service).not.toHaveBeenCalled();
  });
  it("cancels a body not complete within 30 seconds and answers 400", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const held = await heldRequest();
    let settled = false;
    const pending = route.POST(held.request).finally(() => { settled = true; });
    await held.started;
    // FIX-009: 64 KiB in every 5-second window keeps the progress deadline satisfied, so only the 30-second cap ends it.
    for (let window = 0; window < 6; window += 1) {
      held.send(new Uint8Array(64 * 1024));
      await vi.advanceTimersByTimeAsync(window < 5 ? 5_000 : 4_999);
    }
    expect(settled).toBe(false); expect(shared.photoBodySlots.active()).toBe(1); expect(shared.photoUploadLocks.held()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await expectAnswer(await pending, 400, "invalid");
    expect(held.state.cancelled).toBe(true); onlyAccountRan(); expect(shared.photoUploadCooldowns.active(userId)).toBe(true);
  });
  it("frees the lock and the slot when the upload logic throws", async () => {
    sharedUpload.mockRejectedValueOnce(new Error(privateMessage));
    await expect(route.POST(await valid())).rejects.toThrow(privateMessage);
  });
  it("frees the lock and the slot when the body stream fails", async () => {
    const held = await heldRequest();
    const pending = route.POST(held.request);
    await held.started;
    held.fail();
    await expectAnswer(await pending, 400, "invalid");
    // FIX-009: a failing stream is a client that went away, so the cooldown starts.
    onlyAccountRan(); expect(shared.photoUploadCooldowns.active(userId)).toBe(true);
  });
});

describe("after the parse", () => {
  const reserveWith = (response: () => Promise<unknown>) =>
    mocks.userRpc.mockImplementation(async (name: string) => { events.push(name); return name === "my_account" ? account() : response(); });
  it("maps rate_limited to 429 without a decode", async () => {
    reserveWith(async () => ({ data: { ok: false, code: "rate_limited", message: privateMessage }, error: null }));
    await expectAnswer(await route.POST(await valid()), 429, "rate_limited");
    expect(events).toEqual(["my_account", "reserve_photo_upload"]); expect(decode).not.toHaveBeenCalled(); expect(mocks.service).not.toHaveBeenCalled();
  });
  it.each([
    ["null data", async () => ({ data: null, error: null })],
    ["rows", async () => ({ data: [], error: null })],
    ["transport", async () => ({ data: null, error: { message: privateMessage } })],
    ["thrown", async () => { throw new Error(privateMessage); }],
  ] as const)("maps an unreadable reservation (%s) to 503 without a decode", async (_, response) => {
    reserveWith(response);
    await expectAnswer(await route.POST(await valid()), 503, "unavailable");
    expect(decode).not.toHaveBeenCalled(); expect(mocks.service).not.toHaveBeenCalled();
  });
  it("maps capacity to 409 too_many and an undecodable file to 400 invalid", async () => {
    mocks.serviceRpc.mockResolvedValue({ data: { ok: false, code: "invalid_state", message: privateMessage }, error: null });
    await expectAnswer(await route.POST(await valid()), 409, "too_many");
    const { body, type } = await multipart(Buffer.from("not an image"));
    await expectAnswer(await route.POST(post({ body, type, length: String(body.byteLength) })), 400, "invalid");
  });
  it("answers invalid for a missing photo field", async () => {
    const data = new FormData(); data.set("other", "value");
    const encoded = new Response(data); const body = new Uint8Array(await encoded.arrayBuffer());
    await expectAnswer(await route.POST(post({ body, type: encoded.headers.get("content-type")!, length: String(body.byteLength) })), 400, "invalid");
    expect(mocks.user).toHaveBeenCalledOnce(); expect(events).toEqual(["my_account"]);
  });
});

describe("demo and methods", () => {
  it("answers 404 in demo before any check", async () => {
    mocks.mode.mockReturnValue("demo");
    const request = await valid();
    const response = await route.POST(request);
    expect(response.status).toBe(404); expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toBe(CSP);
    expect(request.bodyUsed).toBe(false); nothingRan();
  });
  it.each(["GET", "PUT", "PATCH", "DELETE", "OPTIONS"] as const)("answers 405 to %s", async (method) => {
    const response = route[method]();
    expect(response.status).toBe(405); expect(response.headers.get("allow")).toBe("POST");
    expect(response.headers.get("cache-control")).toBe("no-store"); expect(response.headers.get("content-security-policy")).toBe(CSP);
    nothingRan();
  });
});

describe("FIX-009 slow bodies", () => {
  const asUser = (id: string) => mocks.user.mockResolvedValueOnce({ rpc: async (name: string) => {
    events.push(name); return name === "my_account" ? { data: [{ user_id: id }], error: null } : ok(photoId);
  } });
  it("cuts a trickling body at the first progress window, frees its slot and refuses the sender for 60 seconds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const held = await heldRequest();
    let settled = false;
    const pending = route.POST(held.request).finally(() => { settled = true; });
    await held.started;
    held.send(new Uint8Array(64 * 1024 - 1));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(settled).toBe(false); expect(shared.photoBodySlots.active()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await expectAnswer(await pending, 400, "invalid");
    expect(held.state.cancelled).toBe(true); onlyAccountRan();
    expect(shared.photoBodySlots.active()).toBe(0); expect(shared.photoUploadLocks.held()).toBe(0);
    // The same user is refused at once with the body unread: no lock, no slot, no reservation.
    const again = await heldRequest();
    await expectAnswer(await route.POST(again.request), 429, "rate_limited");
    expect(again.state.pulled).toBe(false); expect(again.request.bodyUsed).toBe(false);
    expect(events).toEqual(["my_account", "my_account"]);
    // Another user is not affected.
    asUser(otherUser(1));
    await expectAnswer(await route.POST(await valid()), 200, "ok");
    expect(events.slice(2)).toEqual(["my_account", "reserve_photo_upload", "reencode", "upload", "register"]);
    await vi.advanceTimersByTimeAsync(shared.UPLOAD_COOLDOWN_MS - 1);
    await expectAnswer(await route.POST(await valid()), 429, "rate_limited");
    await vi.advanceTimersByTimeAsync(1);
    await expectAnswer(await route.POST(await valid()), 200, "ok");
    expect(shared.photoUploadCooldowns.size()).toBe(0);
  });
  it("cuts a body that stops sending within two progress windows", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const held = await heldRequest();
    const pending = route.POST(held.request);
    await held.started;
    held.send(new Uint8Array(64 * 1024));
    await vi.advanceTimersByTimeAsync(10_000);
    await expectAnswer(await pending, 400, "invalid");
    expect(held.state.cancelled).toBe(true); expect(shared.photoUploadCooldowns.active(userId)).toBe(true);
  });
  it("starts the cooldown when the client aborts the request", async () => {
    const abort = new AbortController();
    const held = heldBody();
    const { type } = await multipart();
    const request = new Request("http://campus.test/api/photos", { method: "POST", body: held.body, duplex: "half", signal: abort.signal,
      headers: { host: "campus.test", origin: "http://campus.test", "content-type": type, "content-length": "1000" } } as RequestInit);
    const pending = route.POST(request);
    await held.started;
    abort.abort();
    await expectAnswer(await pending, 400, "invalid");
    onlyAccountRan(); expect(shared.photoUploadCooldowns.active(userId)).toBe(true);
  });
  it("starts no cooldown for a malformed but complete body", async () => {
    const { body } = await multipart();
    await expectAnswer(await route.POST(post({ body, type: "multipart/form-data", length: String(body.byteLength) })), 400, "invalid");
    expect(shared.photoUploadCooldowns.size()).toBe(0);
  });
  it("passes a 4 MiB photo sent at about 200 KiB/s with a 3-second stall", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { body: bytes, type } = await multipart(new Uint8Array(4_194_304));
    const held = heldBody();
    const pending = route.POST(post({ body: held.body, type, length: String(bytes.byteLength) }));
    await held.started;
    const chunk = 80 * 1024;
    for (let offset = 0; offset < bytes.byteLength; offset += chunk) {
      held.send(bytes.subarray(offset, offset + chunk));
      await vi.advanceTimersByTimeAsync(offset === 20 * chunk ? 3_400 : 400);
    }
    held.finish(new Uint8Array(0));
    await pending;
    expect(sharedUpload).toHaveBeenCalledOnce(); expect(decode).toHaveBeenCalledOnce(); expect(decode.mock.calls[0][0]).toHaveLength(4_194_304);
    expect(shared.photoUploadCooldowns.size()).toBe(0);
  });
});
