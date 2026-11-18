// @vitest-environment node
// REFACTOR-001: the web photo routes (cookie session) and the app's (Bearer token) run the same upload, delivery and
// removal functions of src/server/photo-route-core.ts; each family only obtains the session and runs its own
// pre-session checks. The core functions are replaced by spies here, so the routes' own gates and answers stay visible.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  mode: vi.fn(), cookieClient: vi.fn(), cookieGetUser: vi.fn(), create: vi.fn(), bearerGetUser: vi.fn(),
  receive: vi.fn(), deliver: vi.fn(), remove: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/backend", () => ({ backendMode: mocks.mode }));
vi.mock("@/lib/supabase/server", () => ({ createServerSupabase: mocks.cookieClient }));
vi.mock("@supabase/supabase-js", () => ({ createClient: mocks.create }));
vi.mock("@/lib/supabase/config", () => ({ supabasePublicConfig: () => ({ url: "https://synthetic.supabase.co", publishableKey: "sb_publishable_fake" }) }));
vi.mock("@/server/photo-route-core", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/server/photo-route-core")>(),
  receivePhotoUpload: mocks.receive, deliverAuthorizedPhoto: mocks.deliver, removeOwnPhoto: mocks.remove,
}));
import * as core from "@/server/photo-route-core";
import * as shared from "@/server/photo-upload";
import * as webUpload from "@/app/api/photos/route";
import * as webDelivery from "@/app/media/photos/[photoId]/route";
import { removePhoto } from "@/server/photo-actions";
import * as appUpload from "@/app/api/mobile/photos/route";
import * as appSingle from "@/app/api/mobile/photos/[photoId]/route";

const userId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const photoId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const token = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: userId, role: "authenticated" })}.synthetic_signature`;
const cookieClient = { auth: { getUser: mocks.cookieGetUser }, rpc: vi.fn() };
const bearerClient = { auth: { getUser: mocks.bearerGetUser }, rpc: vi.fn() };
const params = { params: Promise.resolve({ photoId }) };
const signedIn = async () => ({ data: { user: { id: userId, is_anonymous: false } }, error: null });
const webRequest = () => new Request("http://127.0.0.1:3207/api/photos", { method: "POST", headers: {
  host: "127.0.0.1:3207", origin: "http://127.0.0.1:3207", "sec-fetch-site": "same-origin",
  "content-type": "multipart/form-data; boundary=x", "content-length": "10",
}, body: "0123456789" });
const appRequest = (method = "POST") => new Request(`http://127.0.0.1:3207/api/mobile/photos${method === "POST" ? "" : `/${photoId}`}`, {
  method, headers: { authorization: `Bearer ${token}`, "content-type": "multipart/form-data; boundary=x", "content-length": "10" },
  ...(method === "POST" ? { body: "0123456789" } : {}),
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.mode.mockReturnValue("supabase");
  mocks.cookieClient.mockResolvedValue(cookieClient);
  mocks.cookieGetUser.mockImplementation(signedIn);
  mocks.create.mockReturnValue(bearerClient);
  mocks.bearerGetUser.mockImplementation(signedIn);
});
afterEach(() => { vi.restoreAllMocks(); });

describe("one core for both route families", () => {
  it("uploads through receivePhotoUpload, with the cookie account on the web and the Bearer account in the app", async () => {
    mocks.receive.mockResolvedValue({ status: "too_many" });
    const web = webRequest(); const app = appRequest();
    const answers = [await webUpload.POST(web), await appUpload.POST(app)];
    for (const response of answers) {
      expect(response.status).toBe(409); expect(await response.json()).toEqual({ status: "too_many" });
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    expect(mocks.receive).toHaveBeenCalledTimes(2);
    expect(mocks.receive.mock.calls[0][0]).toBe(web); expect(mocks.receive.mock.calls[1][0]).toBe(app);
    // The web passes the cookie-session account itself; the app's callback reads only its Bearer session.
    expect(mocks.receive.mock.calls[0][1]).toBe(shared.uploadAccount);
    expect(mocks.cookieClient).not.toHaveBeenCalled();
    mocks.bearerGetUser.mockResolvedValue({ data: { user: null }, error: null });
    await expect(mocks.receive.mock.calls[1][1]()).resolves.toEqual({ status: "unauthenticated" });
    expect(mocks.cookieClient).not.toHaveBeenCalled(); expect(mocks.bearerGetUser).toHaveBeenCalledWith(token);
  });
  it("keeps each family's own pre-session refusal before the core", async () => {
    const crossSite = new Request("http://127.0.0.1:3207/api/photos", { method: "POST", headers: {
      host: "127.0.0.1:3207", origin: "https://evil.example", "content-type": "multipart/form-data; boundary=x", "content-length": "1",
    }, body: "0" });
    expect((await webUpload.POST(crossSite)).status).toBe(403);
    const noToken = new Request("http://127.0.0.1:3207/api/mobile/photos", { method: "POST", headers: {
      "content-type": "multipart/form-data; boundary=x", "content-length": "1",
    }, body: "0" });
    expect((await appUpload.POST(noToken)).status).toBe(401);
    expect(mocks.receive).not.toHaveBeenCalled();
  });
  it("delivers through deliverAuthorizedPhoto with each family's client and user", async () => {
    mocks.deliver.mockResolvedValue(new TextEncoder().encode("synthetic webp").buffer);
    const web = await webDelivery.GET(new Request(`http://127.0.0.1:3207/media/photos/${photoId}`), params);
    const app = await appSingle.GET(appRequest("GET"), params);
    expect(mocks.deliver.mock.calls).toEqual([[cookieClient, userId, photoId], [bearerClient, userId, photoId]]);
    expect([web.status, app.status]).toEqual([200, 200]);
    expect([web.headers.get("vary"), app.headers.get("vary")]).toEqual(["Cookie", "Authorization"]);
    for (const response of [web, app]) {
      expect(response.headers.get("cache-control")).toBe("private, max-age=120");
      expect(response.headers.get("content-type")).toBe("image/webp");
      expect(await response.text()).toBe("synthetic webp");
    }
    // A session the database refuses is the web's 404 and the app's 401, as before.
    mocks.deliver.mockResolvedValue("unauthenticated");
    expect((await webDelivery.GET(new Request(`http://127.0.0.1:3207/media/photos/${photoId}`), params)).status).toBe(404);
    expect((await appSingle.GET(appRequest("GET"), params)).status).toBe(401);
  });
  it("removes through removeOwnPhoto; only the app passes its session's user to compare", async () => {
    mocks.remove.mockResolvedValue("last_photo");
    expect(await removePhoto(photoId)).toEqual({ status: "last_photo" });
    const app = await appSingle.DELETE(appRequest("DELETE"), params);
    expect(app.status).toBe(409); expect(await app.json()).toEqual({ status: "last_photo" });
    expect(mocks.remove.mock.calls).toEqual([[cookieClient, photoId], [bearerClient, photoId, userId]]);
  });
  it("shares the body limits and the JSON headers", async () => {
    const { NO_STORE_HEADERS } = await import("@/server/request-body");
    const { MOBILE_JSON_HEADERS } = await import("@/server/mobile-auth");
    expect(MOBILE_JSON_HEADERS).toBe(NO_STORE_HEADERS);
    expect([core.MAX_UPLOAD_BODY_BYTES, core.BODY_READ_MS]).toEqual([4_194_304 + 65_536, 30_000]);
  });
});
