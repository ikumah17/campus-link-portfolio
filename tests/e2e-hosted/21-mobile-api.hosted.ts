import { test, expect } from "@playwright/test";
import { readBackRunUser } from "./lifecycle";
import { environment, evidence, readState } from "./state";
import { photoPng } from "./ui";

// MOBILE-API-001, its own invocation (CAMPUS_E2E_MOBILE=1): the app's Bearer-only JSON routes under /api/mobile/*,
// called with plain HTTP as the iOS app would, never with a cookie. Run user A (users[0]) signs in through
// /api/mobile/auth/signin, starts onboarding with its own token (the RPC the app calls directly), uploads one photo
// through /api/mobile/photos, loads it through /api/mobile/photos/[id] and removes it there; B (users[1]) signs in the
// same way and is refused A's photo. A wrong password and invalid input are checked on sign-in, and invalid input on
// sign-up (no account is created and no email is sent). Tokens stay in this module and never reach an assertion
// message; evidence keeps statuses, header values and counts only. Teardown deletes both users.
test.describe.configure({ mode: "serial" });

const APP = "http://127.0.0.1:3207";
const BIRTH = "2000-01-02";
type Reply = { status: number; headers: Headers; body: unknown; bytes: Uint8Array };
async function app(path: string, init: { method: "GET" | "POST" | "DELETE"; token?: string; json?: unknown; form?: FormData; headers?: Record<string, string> }): Promise<Reply> {
  const headers: Record<string, string> = { ...init.headers };
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  let body: BodyInit | undefined;
  if (init.json !== undefined) { body = JSON.stringify(init.json); headers["content-type"] = "application/json"; }
  if (init.form) {
    const encoded = new Response(init.form);
    body = new Uint8Array(await encoded.arrayBuffer());
    headers["content-type"] = encoded.headers.get("content-type")!;
  }
  try {
    const response = await fetch(`${APP}${path}`, { method: init.method, headers, body, redirect: "manual", signal: AbortSignal.timeout(60_000) });
    const bytes = new Uint8Array(await response.arrayBuffer());
    let parsed: unknown = null;
    try { parsed = JSON.parse(new TextDecoder().decode(bytes)); } catch { /* not JSON */ }
    return { status: response.status, headers: response.headers, body: parsed, bytes };
  } catch { throw new Error(`${init.method} ${path.split("?")[0]} transport failed (details suppressed)`); }
}
async function supabase(path: string, token: string, init: { method: "GET" | "POST"; body?: unknown } = { method: "GET" }) {
  const env = environment();
  const key = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!key) throw new Error("Missing hosted public credential");
  try {
    const response = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}${path}`, {
      method: init.method, signal: AbortSignal.timeout(30_000),
      headers: { apikey: key, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    return { status: response.status, body: await response.json().catch(() => null) as unknown };
  } catch { throw new Error("Hosted Supabase transport failed (details suppressed)"); }
}
/** The fixed headers every JSON answer must carry; any secret in a header fails without printing it. */
function jsonHeaders(reply: Reply, secrets: string[] = []) {
  const leaked = [...reply.headers].some(([, value]) => secrets.some((secret) => secret && value.includes(secret)));
  return { cacheControl: reply.headers.get("cache-control"), csp: reply.headers.get("content-security-policy"),
    setCookie: reply.headers.get("set-cookie") !== null, cors: reply.headers.get("access-control-allow-origin") !== null, leaked };
}
const SAFE_JSON = { cacheControl: "no-store", csp: "default-src 'none'; frame-ancestors 'none'", setCookie: false, cors: false, leaked: false };

const tokens = { A: "", B: "" };
const results: Record<string, unknown> = {};

test("sign-in returns the session in the body only and keeps the web's refusals", async () => {
  const state = readState();
  for (const [letter, index] of [["A", 0], ["B", 1]] as const) {
    const user = state.users[index];
    const reply = await app("/api/mobile/auth/signin", { method: "POST", json: { email: user.email, password: user.password } });
    const body = reply.body as { status?: unknown; session?: Record<string, unknown> } | null;
    const session = body?.session ?? {};
    const access = typeof session.access_token === "string" ? session.access_token : "";
    const refresh = typeof session.refresh_token === "string" ? session.refresh_token : "";
    expect(reply.status).toBe(200);
    expect(body?.status).toBe("ok");
    expect(Object.keys(session).sort()).toEqual(["access_token", "expires_at", "expires_in", "refresh_token", "token_type"]);
    expect(Boolean(access && refresh)).toBe(true);
    expect(jsonHeaders(reply, [access, refresh])).toEqual(SAFE_JSON);
    // The token is a real session of exactly this user.
    const own = await supabase("/auth/v1/user", access);
    expect(own.status).toBe(200);
    expect((own.body as { id?: unknown } | null)?.id === user.id).toBe(true);
    tokens[letter] = access;
  }
  results.signIn = { status: 200, users: 2, bodyOnly: true };

  const a = state.users[0];
  const started = Date.now();
  const wrong = await app("/api/mobile/auth/signin", { method: "POST", json: { email: a.email, password: `${a.password}x` } });
  const elapsed = Date.now() - started;
  expect([wrong.status, wrong.body]).toEqual([401, { status: "failed" }]);
  expect(elapsed).toBeGreaterThanOrEqual(1500);
  expect(jsonHeaders(wrong)).toEqual(SAFE_JSON);
  results.wrongPassword = { status: wrong.status, atLeast1500ms: elapsed >= 1500 };

  // Refused before any reservation or Auth call.
  const invalid = await app("/api/mobile/auth/signin", { method: "POST", json: { email: "not-an-address", password: "short" } });
  expect(invalid.status).toBe(400);
  expect(Object.keys((invalid.body as { fieldErrors?: object } | null)?.fieldErrors ?? {}).sort()).toEqual(["email", "password"]);
  const signup = await app("/api/mobile/auth/signup", { method: "POST", json: { email: "not-an-address", password: "short" } });
  expect(signup.status).toBe(400);
  expect((signup.body as { status?: unknown } | null)?.status).toBe("invalid");
  expect(jsonHeaders(signup)).toEqual(SAFE_JSON);
  const form = await app("/api/mobile/auth/signin", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" } });
  expect(form.status).toBe(415);
  results.invalidInput = { signIn: invalid.status, signUp: signup.status, formBody: form.status };
});

test("upload, delivery and removal take only the Bearer token", async () => {
  expect(Boolean(tokens.A && tokens.B)).toBe(true);
  const state = readState();
  const started = await supabase("/rest/v1/rpc/start_onboarding", tokens.A, { method: "POST", body: {
    p_display_name: state.users[0].name, p_gender: "other", p_birth_date: BIRTH, p_adult_declared: true,
  } });
  expect([started.status, (started.body as { code?: unknown } | null)?.code]).toEqual([200, "ok"]);

  const photo = () => {
    const data = new FormData();
    data.set("photo", new File([new Uint8Array(png)], "fictional.png", { type: "image/png" }));
    return data;
  };
  const png = await photoPng();
  const noToken = await app("/api/mobile/photos", { method: "POST", form: photo() });
  const cookieOnly = await app("/api/mobile/photos", { method: "POST", form: photo(), headers: { cookie: "sb-exampleprojectrefabc-auth-token=x" } });
  expect([noToken.status, cookieOnly.status]).toEqual([401, 401]);
  expect(jsonHeaders(cookieOnly)).toEqual(SAFE_JSON);
  const uploaded = await app("/api/mobile/photos", { method: "POST", form: photo(), token: tokens.A });
  expect([uploaded.status, uploaded.body]).toEqual([200, { status: "ok" }]);
  expect(jsonHeaders(uploaded, [tokens.A])).toEqual(SAFE_JSON);

  const listed = await supabase("/rest/v1/profile_photos?select=id&status=eq.active", tokens.A);
  const rows = Array.isArray(listed.body) ? listed.body as { id?: unknown }[] : [];
  expect([listed.status, rows.length]).toEqual([200, 1]);
  const id = String(rows[0].id);
  expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

  const delivered = await app(`/api/mobile/photos/${id}`, { method: "GET", token: tokens.A });
  expect(delivered.status).toBe(200);
  // Next adds its own router tokens to Vary; the route's Authorization must be among them, and Cookie must not.
  const vary = (delivered.headers.get("vary") ?? "").split(",").map((token) => token.trim().toLowerCase());
  expect({ type: delivered.headers.get("content-type"), cache: delivered.headers.get("cache-control"), varyAuthorization: vary.includes("authorization"),
    varyCookie: vary.includes("cookie"), setCookie: delivered.headers.get("set-cookie") !== null })
    .toEqual({ type: "image/webp", cache: "private, max-age=120", varyAuthorization: true, varyCookie: false, setCookie: false });
  const riff = new TextDecoder().decode(delivered.bytes.slice(0, 4)) + new TextDecoder().decode(delivered.bytes.slice(8, 12));
  expect(riff).toBe("RIFFWEBP");
  const anonymous = await app(`/api/mobile/photos/${id}`, { method: "GET" });
  const other = await app(`/api/mobile/photos/${id}`, { method: "GET", token: tokens.B });
  // The web delivery path does not accept a Bearer token: without its cookie it refuses as before.
  const web = await app(`/media/photos/${id}`, { method: "GET", token: tokens.A });
  expect([anonymous.status, other.status, web.status]).toEqual([401, 404, 404]);
  expect(jsonHeaders(other)).toEqual(SAFE_JSON);

  const othersRemove = await app(`/api/mobile/photos/${id}`, { method: "DELETE", token: tokens.B });
  expect(othersRemove.status).toBe(503);
  expect((await app(`/api/mobile/photos/${id}`, { method: "GET", token: tokens.A })).status).toBe(200);
  const removed = await app(`/api/mobile/photos/${id}`, { method: "DELETE", token: tokens.A });
  expect([removed.status, removed.body]).toEqual([200, { status: "ok" }]);
  expect(jsonHeaders(removed, [tokens.A])).toEqual(SAFE_JSON);
  const gone = await app(`/api/mobile/photos/${id}`, { method: "GET", token: tokens.A });
  expect(gone.status).toBe(404);
  const readBack = await readBackRunUser(0);
  expect(readBack.photos).toEqual([]);
  results.photos = { noToken: noToken.status, cookieOnly: cookieOnly.status, upload: uploaded.status, deliver: delivered.status,
    deliverHeaders: { cache: "private, max-age=120", varyAuthorization: true }, anonymous: anonymous.status, otherUser: other.status,
    webPathWithBearer: web.status, otherUserRemove: othersRemove.status, remove: removed.status, afterRemove: gone.status, storageObjects: readBack.photos.length };
  evidence("mobileApi", { status: "pass", ...results });
});
