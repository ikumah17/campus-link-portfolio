// @vitest-environment node
// MOBILE-API-001: the app's photo routes under /api/mobile/photos take only a Bearer token. They keep the web routes'
// order and limits (FIX-002, FIX-004, SEC-011, SEC-004) and checks (delivery authorization, removePhoto), never read a
// cookie and never set one.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import sharp from "sharp";
const mocks = vi.hoisted(() => ({ mode: vi.fn(), create: vi.fn(), getUser: vi.fn(), userRpc: vi.fn(), serviceRpc: vi.fn(),
  from: vi.fn(), upload: vi.fn(), remove: vi.fn(), download: vi.fn(), uuid: vi.fn(), cookies: vi.fn(), cookieClient: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/backend", () => ({ backendMode: mocks.mode }));
vi.mock("@supabase/supabase-js", () => ({ createClient: mocks.create }));
vi.mock("@/lib/supabase/config", () => ({ supabasePublicConfig: () => ({ url: "https://synthetic.supabase.co", publishableKey: "sb_publishable_fake" }) }));
// Neither the cookie store nor the cookie-session client may be touched by these routes.
vi.mock("next/headers", () => ({ cookies: mocks.cookies, headers: mocks.cookies }));
vi.mock("@/lib/supabase/server", () => ({ createServerSupabase: mocks.cookieClient }));
vi.mock("node:crypto", async (importOriginal) => ({ ...await importOriginal<typeof import("node:crypto")>(), randomUUID: mocks.uuid }));
import * as images from "@/server/storage/photo-image";
import * as shared from "@/server/photo-upload";
import * as upload from "@/app/api/mobile/photos/route";
import * as single from "@/app/api/mobile/photos/[photoId]/route";
import { BODY_READ_MS, MAX_UPLOAD_BODY_BYTES } from "@/server/photo-route-core";

const userId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const photoId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const otherId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const token = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: userId, role: "authenticated" })}.synthetic_signature`;
const privateMessage = "private DB or storage message";
const BOUND = 4_194_304 + 65_536;
const CSP = "default-src 'none'; frame-ancestors 'none'";
const ok = (ref: string | null = null) => ({ data: { ok: true, code: "ok", ref }, error: null });
const account = (id = userId, status = "active") => ({ data: [{ user_id: id, account_status: status }], error: null });
const ownRow = { photo_id: photoId, storage_path: `${userId}/${photoId}.webp` };
let png: Buffer;
let events: string[];
let fetchSpy: ReturnType<typeof vi.spyOn>;
let consoleSpies: MockInstance[];
let decode: MockInstance<typeof images.reencodePhoto>;
let sharedUpload: MockInstance<typeof shared.uploadPhoto>;
beforeAll(async () => { png = await sharp({ create: { width: 20, height: 10, channels: 3, background: "white" } }).png().toBuffer(); });
beforeEach(() => {
  vi.resetAllMocks(); events = []; shared.photoUploadCooldowns.clear();
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "sb_secret_fake");
  fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network forbidden"));
  consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((name) => vi.spyOn(console, name));
  mocks.mode.mockReturnValue("supabase"); mocks.uuid.mockReturnValue(photoId);
  mocks.cookies.mockImplementation(() => { throw new Error("cookies read"); });
  mocks.cookieClient.mockImplementation(() => { throw new Error("cookie client created"); });
  // The publishable key makes the user's Bearer client; the server key the storage/registration client.
  mocks.create.mockImplementation((_url: string, key: string) => key === "sb_secret_fake"
    ? { storage: { from: mocks.from }, rpc: mocks.serviceRpc }
    : { auth: { getUser: mocks.getUser }, rpc: mocks.userRpc });
  mocks.getUser.mockImplementation(async () => { events.push("getUser"); return { data: { user: { id: userId, is_anonymous: false } }, error: null }; });
  mocks.userRpc.mockImplementation(async (name: string) => {
    events.push(name);
    if (name === "my_account") return account();
    if (name === "authorize_photo_delivery") return { data: [ownRow], error: null };
    return ok(photoId);
  });
  mocks.from.mockReturnValue({ upload: mocks.upload, remove: mocks.remove, download: mocks.download });
  mocks.upload.mockImplementation(async () => { events.push("upload"); return { error: null }; });
  mocks.serviceRpc.mockImplementation(async () => { events.push("register"); return ok(photoId); });
  mocks.remove.mockImplementation(async () => { events.push("delete"); return { error: null }; });
  mocks.download.mockImplementation(async () => { events.push("download"); return { data: new Blob([new TextEncoder().encode("synthetic webp")]), error: null }; });
  const realReencode = images.reencodePhoto;
  decode = vi.spyOn(images, "reencodePhoto").mockImplementation(async (bytes) => { events.push("reencode"); return realReencode(bytes); });
  const realUpload = shared.uploadPhoto;
  sharedUpload = vi.spyOn(shared, "uploadPhoto").mockImplementation((data, session) => realUpload(data, session));
});
afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  // No cookie is read and nothing is logged, so no token can reach a log.
  expect(mocks.cookies).not.toHaveBeenCalled(); expect(mocks.cookieClient).not.toHaveBeenCalled();
  for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers();
  // Every outcome frees this user's lock and the body slot.
  expect(shared.photoUploadLocks.held()).toBe(0); expect(shared.photoBodySlots.active()).toBe(0);
});

const auth = { authorization: `Bearer ${token}` };
async function multipart(bytes: Uint8Array = png) {
  const data = new FormData();
  data.set("photo", new File([new Uint8Array(bytes)], "synthetic.png", { type: "image/png" }));
  const encoded = new Response(data);
  return { body: new Uint8Array(await encoded.arrayBuffer()), type: encoded.headers.get("content-type")! };
}
type Options = { body?: BodyInit; type?: string; length?: string; headers?: Record<string, string | undefined> };
function post({ body, type, length, headers = auth }: Options) {
  const all: Record<string, string | undefined> = { host: "campus.test", "content-type": type, "content-length": length, ...headers };
  const init: RequestInit & { duplex?: "half" } = { method: "POST", body, duplex: "half",
    headers: Object.fromEntries(Object.entries(all).filter((entry): entry is [string, string] => entry[1] !== undefined)) };
  return new Request("http://campus.test/api/mobile/photos", init);
}
async function valid(headers: Record<string, string | undefined> = auth) {
  const { body, type } = await multipart();
  return post({ body, type, length: String(body.byteLength), headers });
}
function expectHeaders(response: Response) {
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("content-security-policy")).toBe(CSP);
  expect(response.headers.get("set-cookie")).toBeNull();
  expect(response.headers.get("access-control-allow-origin")).toBeNull();
  for (const [, value] of response.headers) expect(value).not.toContain(token);
}
async function expectAnswer(response: Response, http: number, status: string) {
  expect(response.status).toBe(http);
  expectHeaders(response);
  const body = await response.json();
  expect(body).toEqual({ status });
  const serialized = JSON.stringify(body);
  for (const value of [privateMessage, userId, photoId, token, "synthetic.png"]) expect(serialized).not.toContain(value);
}
function nothingRan() {
  expect(sharedUpload).not.toHaveBeenCalled(); expect(mocks.create).not.toHaveBeenCalled();
  expect(decode).not.toHaveBeenCalled(); expect(events).toEqual([]);
}
/** Only the Bearer check and the account read ran: the body was refused before the shared module. */
function onlyAccountRan() {
  expect(sharedUpload).not.toHaveBeenCalled(); expect(events).toEqual(["getUser", "my_account"]);
  expect(decode).not.toHaveBeenCalled(); expect(mocks.serviceRpc).not.toHaveBeenCalled(); expect(mocks.upload).not.toHaveBeenCalled();
}
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
const userClient = () => mocks.create.mock.calls.find((call) => call[1] === "sb_publishable_fake");

describe("POST /api/mobile/photos: Bearer only", () => {
  it("stores a photo through the shared module with the token's own client", async () => {
    await expectAnswer(await upload.POST(await valid()), 200, "ok");
    expect(events).toEqual(["getUser", "my_account", "reserve_photo_upload", "reencode", "upload", "register"]);
    expect(mocks.getUser).toHaveBeenCalledWith(token);
    // A client that keeps nothing and sends the token on every RPC.
    expect(userClient()![2]).toEqual({
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, flowType: "pkce" },
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    expect(sharedUpload.mock.calls[0][1]).toMatchObject({ status: "ok", userId });
  });
  it.each([
    ["no Authorization header", {}],
    ["a session cookie alone", { cookie: `sb-synthetic-auth-token=base64-${b64({ access_token: token })}` }],
    ["a cookie and an Origin of this site", { cookie: "sb-synthetic-auth-token=x", origin: "http://campus.test", "sec-fetch-site": "same-origin" }],
    ["a Basic header", { authorization: `Basic ${token}` }],
    ["a lowercase scheme", { authorization: `bearer ${token}` }],
    ["a token that is not a JWT", { authorization: "Bearer not-a-jwt" }],
    ["two tokens", { authorization: `Bearer ${token}, Bearer ${token}` }],
    ["a second space", { authorization: `Bearer  ${token}` }],
    ["an oversized header", { authorization: `Bearer ${token}${"a".repeat(8200)}` }],
  ])("answers 401 to %s before anything else runs", async (_, headers) => {
    const request = await valid(headers);
    await expectAnswer(await upload.POST(request), 401, "unauthenticated");
    expect(request.bodyUsed).toBe(false); nothingRan();
  });
  it.each([
    ["a token Auth rejects", 401, "unauthenticated", () => mocks.getUser.mockResolvedValue({ data: { user: null }, error: { status: 401, code: "bad_jwt", message: privateMessage } })],
    ["a revoked session", 401, "unauthenticated", () => mocks.getUser.mockResolvedValue({ data: { user: null }, error: { status: 403, code: "session_not_found", message: privateMessage } })],
    ["an anonymous user", 401, "unauthenticated", () => mocks.getUser.mockResolvedValue({ data: { user: { id: userId, is_anonymous: true } }, error: null })],
    ["an Auth outage", 503, "unavailable", () => mocks.getUser.mockResolvedValue({ data: { user: null }, error: { status: 500, message: privateMessage } })],
    ["an Auth rate limit", 503, "unavailable", () => mocks.getUser.mockResolvedValue({ data: { user: null }, error: { status: 429, message: privateMessage } })],
    ["a thrown Auth call", 503, "unavailable", () => mocks.getUser.mockRejectedValue(new Error(privateMessage))],
  ] as const)("answers at once with the body unread for %s", async (_, http, status, arrange) => {
    arrange();
    const held = await heldRequest();
    await expectAnswer(await upload.POST(held.request), http, status);
    expect(held.state.pulled).toBe(false); expect(held.request.bodyUsed).toBe(false);
    expect(mocks.userRpc).not.toHaveBeenCalled(); expect(sharedUpload).not.toHaveBeenCalled();
  });
  it.each([
    ["my_account rejects the token", 401, "unauthenticated", () => ({ data: null, error: { code: "PGRST301", message: privateMessage }, status: 401 })],
    ["the account read fails", 503, "unavailable", () => ({ data: null, error: { message: privateMessage } })],
    ["the account is another user's", 503, "unavailable", () => account(otherId)],
  ] as const)("answers at once with the body unread when %s", async (_, http, status, answer) => {
    mocks.userRpc.mockImplementation(async (name: string) => { events.push(name); return answer(); });
    const held = await heldRequest();
    await expectAnswer(await upload.POST(held.request), http, status);
    expect(held.state.pulled).toBe(false); expect(events).toEqual(["getUser", "my_account"]); expect(sharedUpload).not.toHaveBeenCalled();
  });
});

describe("POST /api/mobile/photos: the web route's limits", () => {
  it("uses the web route's 4 MiB + 64 KiB bound and 30-second deadline", () => {
    expect([MAX_UPLOAD_BODY_BYTES, BODY_READ_MS, shared.MAX_PHOTO_BYTES]).toEqual([BOUND, 30_000, 4_194_304]);
    expect(BOUND).toBeLessThan(4_500_000);
  });
  it.each([["missing", undefined], ["JSON", "application/json"], ["text", "text/plain"]])("refuses a %s content type with 415 before Auth is asked", async (_, type) => {
    const { body } = await multipart();
    const request = post({ body, type, length: String(body.byteLength) });
    await expectAnswer(await upload.POST(request), 415, "invalid");
    expect(request.bodyUsed).toBe(false); nothingRan();
  });
  it.each([["missing", undefined], ["non-numeric", "abc"], ["negative", "-1"], ["huge", "99999999999"]])("refuses a %s Content-Length with 411", async (_, length) => {
    const { body, type } = await multipart();
    const request = post({ body, type, length });
    await expectAnswer(await upload.POST(request), 411, "invalid");
    expect(request.bodyUsed).toBe(false); nothingRan();
  });
  it("refuses a declared length over the bound with 413 before Auth is asked", async () => {
    const { body, type } = await multipart();
    const request = post({ body, type, length: String(BOUND + 1) });
    await expectAnswer(await upload.POST(request), 413, "too_large");
    expect(request.bodyUsed).toBe(false); nothingRan();
  });
  it("cuts off a body larger than the bound even when Content-Length lied", async () => {
    const chunk = new Uint8Array(1_048_576);
    let pulled = 0, cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { pulled += chunk.byteLength; controller.enqueue(chunk); },
      cancel() { cancelled = true; },
    });
    const { type } = await multipart();
    await expectAnswer(await upload.POST(post({ body, type, length: "100" })), 413, "too_large");
    expect(cancelled).toBe(true); expect(pulled).toBeLessThanOrEqual(BOUND + 3 * chunk.byteLength);
    onlyAccountRan();
  });
  it("lets the shared module map a 4 MiB + 1 photo to too_large", async () => {
    const { body, type } = await multipart(new Uint8Array(4_194_305));
    await expectAnswer(await upload.POST(post({ body, type, length: String(body.byteLength) })), 413, "too_large");
    expect(sharedUpload).toHaveBeenCalledOnce(); expect(decode).not.toHaveBeenCalled();
  });
  it("refuses a second concurrent upload by the same user with the body unread", async () => {
    const first = await heldRequest();
    const pending = upload.POST(first.request);
    await first.started;
    const second = await heldRequest();
    await expectAnswer(await upload.POST(second.request), 429, "rate_limited");
    expect(second.state.pulled).toBe(false); expect(shared.photoBodySlots.active()).toBe(1);
    first.finish(first.bytes);
    await expectAnswer(await pending, 200, "ok");
    expect(events.filter((name) => name === "reserve_photo_upload")).toHaveLength(1);
  });
  it("shares the web route's per-user lock, so a web upload in progress refuses the app's", async () => {
    const webUpload = shared.photoUploadLocks.acquire(userId)!;
    try {
      const held = await heldRequest();
      await expectAnswer(await upload.POST(held.request), 429, "rate_limited");
      expect(held.state.pulled).toBe(false); onlyAccountRan();
    } finally { webUpload(); }
  });
  it("shares the web route's four body slots and takes no fifth", async () => {
    const taken = await Promise.all([1, 2, 3, 4].map(() => shared.photoBodySlots.acquire()));
    try {
      const held = await heldRequest();
      await expectAnswer(await upload.POST(held.request), 429, "rate_limited");
      expect(held.state.pulled).toBe(false); expect(shared.photoUploadLocks.held()).toBe(0); onlyAccountRan();
    } finally { for (const release of taken) release!(); }
  });
  it("cancels a body not complete within 30 seconds and answers 400", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const held = await heldRequest();
    let settled = false;
    const pending = upload.POST(held.request).finally(() => { settled = true; });
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
  it("frees the lock and the slot when the body stream fails", async () => {
    const held = await heldRequest();
    const pending = upload.POST(held.request);
    await held.started;
    held.fail();
    await expectAnswer(await pending, 400, "invalid");
    // FIX-009: a failing stream is a client that went away, so the cooldown starts.
    onlyAccountRan(); expect(shared.photoUploadCooldowns.active(userId)).toBe(true);
  });
  it("maps the reservation, capacity and decode outcomes like the web route", async () => {
    mocks.userRpc.mockImplementation(async (name: string) => { events.push(name); return name === "my_account" ? account() : { data: { ok: false, code: "rate_limited" }, error: null }; });
    await expectAnswer(await upload.POST(await valid()), 429, "rate_limited");
    expect(decode).not.toHaveBeenCalled();
    mocks.userRpc.mockImplementation(async (name: string) => { events.push(name); return name === "my_account" ? account() : ok(); });
    mocks.serviceRpc.mockResolvedValue({ data: { ok: false, code: "invalid_state", message: privateMessage }, error: null });
    await expectAnswer(await upload.POST(await valid()), 409, "too_many");
    // Compensation: the stored object of a refused registration is removed.
    expect(mocks.remove).toHaveBeenCalledWith([`${userId}/${photoId}.webp`]);
    const { body, type } = await multipart(Buffer.from("not an image"));
    await expectAnswer(await upload.POST(post({ body, type, length: String(body.byteLength) })), 400, "invalid");
  });
  it("answers 404 in demo before any check and 405 to other methods", async () => {
    mocks.mode.mockReturnValue("demo");
    const request = await valid();
    const response = await upload.POST(request);
    expect(response.status).toBe(404); expectHeaders(response); expect(request.bodyUsed).toBe(false); nothingRan();
    for (const method of ["GET", "PUT", "PATCH", "DELETE", "OPTIONS"] as const) {
      const refused = upload[method]();
      expect(refused.status).toBe(405); expect(refused.headers.get("allow")).toBe("POST"); expectHeaders(refused);
    }
  });
});

function photoRequest(method: "GET" | "DELETE", headers: Record<string, string> = auth, id = photoId) {
  return [new Request(`http://campus.test/api/mobile/photos/${encodeURIComponent(id)}`, { method, headers }), { params: Promise.resolve({ photoId: id }) }] as const;
}
const deliver = (headers?: Record<string, string>, id?: string) => single.GET(...photoRequest("GET", headers, id));
const remove = (headers?: Record<string, string>, id?: string) => single.DELETE(...photoRequest("DELETE", headers, id));
const fingerprint = async (response: Response) => ({ status: response.status, headers: [...response.headers], bytes: [...new Uint8Array(await response.arrayBuffer())] });
const denied = { status: 404, headers: [["cache-control", "no-store"], ["content-security-policy", CSP]], bytes: [] };

describe("GET /api/mobile/photos/[photoId]", () => {
  it("delivers an authorized photo with private caching that varies by Authorization", async () => {
    expect(single.dynamic).toBe("force-dynamic");
    const response = await deliver();
    expect(response.status).toBe(200);
    expect(Object.fromEntries(response.headers)).toEqual({
      "content-type": "image/webp", "cache-control": "private, max-age=120", vary: "Authorization",
      "x-content-type-options": "nosniff", "cross-origin-resource-policy": "same-origin", "content-security-policy": CSP,
    });
    expect(new TextDecoder().decode(await response.arrayBuffer())).toBe("synthetic webp");
    // The web delivery's order: the token, per-request authorization, the own photo's account, then the E-3 read.
    expect(events).toEqual(["getUser", "authorize_photo_delivery", "my_account", "download"]);
    expect(mocks.userRpc).toHaveBeenCalledWith("authorize_photo_delivery", { p_photo_ids: [photoId] });
  });
  it("reads no account for another user's photo", async () => {
    mocks.userRpc.mockImplementation(async (name: string) => { events.push(name); return { data: [{ photo_id: photoId, storage_path: `${otherId}/${photoId}.webp` }], error: null }; });
    expect((await deliver()).status).toBe(200);
    expect(events).toEqual(["getUser", "authorize_photo_delivery", "download"]);
  });
  it.each([
    ["no Authorization header", {}],
    ["a session cookie alone", { cookie: "sb-synthetic-auth-token=x" }],
    ["a malformed header", { authorization: "Bearer x" }],
  ])("answers 401 to %s with nothing read", async (_, headers) => {
    await expectAnswer(await deliver(headers), 401, "unauthenticated");
    expect(events).toEqual([]); expect(mocks.create).not.toHaveBeenCalled();
  });
  it("answers 401 to a token Auth rejects and to an RPC that rejects it", async () => {
    mocks.getUser.mockResolvedValueOnce({ data: { user: null }, error: { status: 401, message: privateMessage } });
    await expectAnswer(await deliver(), 401, "unauthenticated");
    mocks.userRpc.mockResolvedValueOnce({ data: null, error: { code: "PGRST301" }, status: 401 });
    await expectAnswer(await deliver(), 401, "unauthenticated");
    expect(mocks.download).not.toHaveBeenCalled();
  });
  it.each([
    ["an unauthorized photo", () => mocks.userRpc.mockImplementation(async () => ({ data: [], error: null }))],
    ["a row for another photo", () => mocks.userRpc.mockImplementation(async () => ({ data: [{ ...ownRow, photo_id: otherId }], error: null }))],
    ["a refused authorization", () => mocks.userRpc.mockImplementation(async () => ({ data: { ok: false, code: "not_available" }, error: null }))],
    ["an own photo of a deleted account", () => mocks.userRpc.mockImplementation(async (name: string) => name === "my_account" ? account(userId, "deleted") : { data: [ownRow], error: null })],
    ["an unreadable own account", () => mocks.userRpc.mockImplementation(async (name: string) => name === "my_account" ? { data: null, error: { message: privateMessage } } : { data: [ownRow], error: null })],
    ["a storage failure", () => mocks.download.mockResolvedValue({ data: null, error: { message: privateMessage } })],
    ["an Auth outage", () => mocks.getUser.mockResolvedValue({ data: { user: null }, error: { status: 503 } })],
  ])("answers the same 404 to %s", async (_, arrange) => {
    arrange();
    expect(await fingerprint(await deliver())).toEqual(denied);
  });
  it.each(["x", photoId.toUpperCase(), `../${photoId}`, ""])("refuses malformed id %# with 404 before Auth is asked", async (id) => {
    expect(await fingerprint(await deliver(auth, id))).toEqual(denied);
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("answers 404 in demo and 405 to other methods", async () => {
    mocks.mode.mockReturnValue("demo");
    expect(await fingerprint(await deliver())).toEqual(denied);
    for (const method of ["POST", "PUT", "PATCH", "OPTIONS"] as const) {
      const refused = single[method]();
      expect(refused.status).toBe(405); expect(refused.headers.get("allow")).toBe("GET, DELETE"); expectHeaders(refused);
    }
  });
});

describe("DELETE /api/mobile/photos/[photoId]", () => {
  it("removes an own photo like the removePhoto action", async () => {
    await expectAnswer(await remove(), 200, "ok");
    expect(events).toEqual(["getUser", "my_account", "remove_photo", "delete"]);
    expect(mocks.userRpc).toHaveBeenCalledWith("remove_photo", { p_photo: photoId });
    expect(mocks.remove).toHaveBeenCalledWith([`${userId}/${photoId}.webp`]);
  });
  it.each([
    ["no Authorization header", {}],
    ["a session cookie alone", { cookie: "sb-synthetic-auth-token=x" }],
  ])("answers 401 to %s with nothing run", async (_, headers) => {
    await expectAnswer(await remove(headers), 401, "unauthenticated");
    expect(events).toEqual([]);
  });
  it("answers 401 to a token Auth rejects", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: { status: 403 } });
    await expectAnswer(await remove(), 401, "unauthenticated");
    expect(mocks.userRpc).not.toHaveBeenCalled();
  });
  it("answers 400 to a malformed id before Auth is asked", async () => {
    await expectAnswer(await remove(auth, "x"), 400, "invalid");
    expect(events).toEqual([]);
  });
  it.each([
    ["the last photo of a completed profile", 409, "last_photo", { data: { ok: false, code: "invalid_state" }, error: null }],
    ["no owned row", 503, "unavailable", { data: { ok: false, code: "not_available" }, error: null }],
    ["a rejected token", 401, "unauthenticated", { data: null, error: { code: "PGRST301" }, status: 401 }],
  ] as const)("maps %s like the web action and removes no object", async (_, http, status, answer) => {
    mocks.userRpc.mockImplementation(async (name: string) => { events.push(name); return name === "my_account" ? account() : answer; });
    await expectAnswer(await remove(), http, status);
    expect(mocks.remove).not.toHaveBeenCalled();
  });
  it("refuses when my_account names another user", async () => {
    mocks.userRpc.mockImplementation(async (name: string) => { events.push(name); return account(otherId); });
    await expectAnswer(await remove(), 503, "unavailable");
    expect(events).toEqual(["getUser", "my_account"]);
  });
  it("still answers ok when the best-effort object removal fails", async () => {
    mocks.remove.mockResolvedValue({ error: { message: privateMessage } });
    await expectAnswer(await remove(), 200, "ok");
  });
});
