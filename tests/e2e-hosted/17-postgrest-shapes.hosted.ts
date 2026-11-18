import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { createRunUsers } from "./lifecycle";
import { environment, evidence, readState } from "./state";

// TEST-013, its own invocation (CAMPUS_E2E_POSTGREST=1): PostgREST answers every refusal in one HTTP shape. Plain HTTP to
// /rest/v1/rpc/* with no browser and no app server. Run user 0 (A) has no profile; run user 1 (B) has only the profile its
// own start_onboarding makes (the app's first onboarding write), so invalid_state is reachable. Each signs in with its own
// password; tokens stay in this module. Anon sends the publishable key only. Every RPC is called once per actor in the
// first test and the later tests compare what came back: outcome refusals (HTTP 200, {ok, code, ref}), P0001 validation
// and forbidden exceptions, and anon. outcome_code has no 'forbidden' (it is always the P0001 exception), and the other
// outcome codes need a second account state or exhausting a rate limit, so the outcome group covers not_available and
// invalid_state. TEST-015 adds rate_limited: a fresh run user C (never A or B) calls reserve_mfa_attempt (10 per user per
// 10 minutes) until refused. The OpenAPI root and an unknown RPC's hint are recorded, not asserted. Evidence keeps RPC
// names, actor letters, statuses, codes, call counts and header names only; teardown deletes every run user.
test.describe.configure({ mode: "serial" });

type Actor = "A" | "B" | "C" | "anon";
type Reply = { rpc: string; actor: Actor; status: number; contentType: string | null; headers: string[]; framing: string[]; body: unknown };
type Case = { rpc: string; actor: "A" | "B"; args: Record<string, unknown>; expect: string };

// Per-request values (not set for the body): the date and request/trace identifiers.
const volatile = /^(date|age|cf-ray|server-timing|x-envoy-upstream-service-time)$|request-id/;
// Transport framing the gateway picks by body size (it compresses longer bodies), not set by PostgREST for the body:
// recorded per reply, not compared. TEST-013's first run saw anon's shorter remove_photo message sent uncompressed.
const framing = /^(content-length|content-encoding|transfer-encoding|vary)$/;
const env = () => {
  const value = environment();
  const key = value.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? value.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!key) throw new Error("Missing hosted public credential");
  return { url: value.NEXT_PUBLIC_SUPABASE_URL, key };
};
async function wire(path: string, options: { method: "GET" | "POST"; body?: unknown; jwt?: string }) {
  const { url, key } = env();
  try {
    const response = await fetch(`${url}${path}`, {
      method: options.method, signal: AbortSignal.timeout(30_000),
      headers: { apikey: key, ...(options.jwt ? { Authorization: `Bearer ${options.jwt}` } : {}), "Content-Type": "application/json" },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    const text = await response.text();
    let body: unknown = null;
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    const names = [...response.headers.keys()].filter(name => !volatile.test(name)).sort();
    return { status: response.status, contentType: response.headers.get("content-type"),
      headers: names.filter(name => !framing.test(name)), framing: names.filter(name => framing.test(name)), body, text };
  } catch { throw new Error("Hosted PostgREST transport failed (details suppressed)"); }
}
async function ownToken(index: number): Promise<string> {
  const user = readState().users[index];
  const value = await wire("/auth/v1/token?grant_type=password", { method: "POST", body: { email: user.email, password: user.password } });
  const data = value.body as { access_token?: unknown; user?: { id?: unknown } } | null;
  if (value.status !== 200 || data?.user?.id !== user.id || typeof data.access_token !== "string") throw new Error("Hosted run-user sign-in failed (details suppressed)");
  return data.access_token;
}
const kind = (value: unknown) => value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
const object = (value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
/** Everything the caller sees except the one field allowed to differ. */
const signature = (reply: Reply, except: string) => {
  const body = object(reply.body);
  return JSON.stringify({ status: reply.status, contentType: reply.contentType, headers: reply.headers,
    keys: body ? Object.keys(body).sort() : kind(reply.body),
    types: body ? Object.fromEntries(Object.keys(body).sort().map(key => [key, kind(body[key])])) : null,
    rest: body ? Object.fromEntries(Object.keys(body).sort().filter(key => key !== except).map(key => [key, body[key]])) : null });
};

const tokens: Record<"A" | "B" | "C", string> = { A: "", B: "", C: "" };
const replies = { outcome: [] as (Reply & { expected: string })[], validation: [] as Reply[], forbidden: [] as Reply[], anon: [] as Reply[], removed: [] as Reply[] };
const BIRTH = "2000-01-02";
const onboarding = () => ({ p_display_name: readState().users[1].name, p_gender: "other", p_birth_date: BIRTH, p_adult_declared: true });

// One call per RPC per actor. Random ids name nothing; null or invalid arguments raise validation before any write.
const outcomeCases = (): Case[] => [
  { rpc: "like_user", actor: "B", args: { p_target: randomUUID() }, expect: "not_available" },
  { rpc: "end_connection", actor: "B", args: { p_connection: randomUUID() }, expect: "not_available" },
  { rpc: "start_onboarding", actor: "B", args: onboarding(), expect: "invalid_state" },
  { rpc: "complete_profile", actor: "B", args: {}, expect: "invalid_state" },
];
const validationCases = (): Case[] => [
  { rpc: "like_user", actor: "A", args: { p_target: null }, expect: "validation" },
  { rpc: "unlike_user", actor: "A", args: { p_target: null }, expect: "validation" },
  { rpc: "list_my_likes", actor: "B", args: { p_direction: null }, expect: "validation" },
  { rpc: "get_like_state", actor: "B", args: { p_target: null }, expect: "validation" },
  { rpc: "unblock_user", actor: "A", args: { p_target: null }, expect: "validation" },
  { rpc: "update_birth_date", actor: "B", args: { p_birth_date: null }, expect: "validation" },
  { rpc: "remove_photo", actor: "B", args: { p_photo: null }, expect: "validation" },
  { rpc: "block_user", actor: "B", args: { p_target: null }, expect: "validation" },
];
// A has no profile (require_account) and neither has a staff role at aal2 (require_staff).
const forbiddenCases = (): Case[] => [
  { rpc: "complete_profile", actor: "A", args: {}, expect: "forbidden" },
  { rpc: "like_user", actor: "A", args: { p_target: randomUUID() }, expect: "forbidden" },
  { rpc: "unlike_user", actor: "A", args: { p_target: randomUUID() }, expect: "forbidden" },
  { rpc: "end_connection", actor: "A", args: { p_connection: randomUUID() }, expect: "forbidden" },
  { rpc: "admin_claim_submission", actor: "A", args: { p_id: randomUUID() }, expect: "forbidden" },
  { rpc: "admin_claim_submission", actor: "B", args: { p_id: randomUUID() }, expect: "forbidden" },
  { rpc: "admin_release_submission", actor: "B", args: { p_id: randomUUID() }, expect: "forbidden" },
];
const anonArgs = (): [string, Record<string, unknown>][] => [
  ["like_user", { p_target: randomUUID() }],
  ["unlike_user", { p_target: randomUUID() }],
  ["list_my_likes", { p_direction: "received" }],
  ["get_like_state", { p_target: randomUUID() }],
  ["end_connection", { p_connection: randomUUID() }],
  ["start_onboarding", { p_display_name: "E2E", p_gender: "other", p_birth_date: BIRTH, p_adult_declared: true }],
  ["complete_profile", {}],
  ["update_birth_date", { p_birth_date: BIRTH }],
  ["remove_photo", { p_photo: randomUUID() }],
  ["block_user", { p_target: randomUUID() }],
  ["unblock_user", { p_target: randomUUID() }],
  ["admin_claim_submission", { p_id: randomUUID() }],
  ["admin_release_submission", { p_id: randomUUID() }],
];
const KNOWN = [...new Set(anonArgs().map(([rpc]) => rpc))];
// HOSTED-E2E-LIKES: order 34 dropped the request and mode RPCs; PostgREST no longer finds them (404 PGRST202).
const removedArgs = (): [string, Record<string, unknown>][] => [
  ["send_connection_request", { p_target: randomUUID(), p_mode: "friends" }],
  ["respond_connection_request", { p_request: randomUUID(), p_accept: true }],
  ["cancel_connection_request", { p_request: randomUUID() }],
  ["list_my_requests", {}],
  ["set_modes", { p_modes: ["friends"] }],
];
async function rpc(actor: Actor, name: string, args: Record<string, unknown>): Promise<Reply> {
  const value = await wire(`/rest/v1/rpc/${name}`, { method: "POST", body: args, jwt: actor === "anon" ? undefined : tokens[actor] });
  return { rpc: name, actor, status: value.status, contentType: value.contentType, headers: value.headers, framing: value.framing, body: value.body };
}
const brief = (reply: Reply) => {
  const body = object(reply.body);
  return { rpc: reply.rpc, actor: reply.actor, status: reply.status, code: body?.code ?? null, message: body?.message ?? null, framing: reply.framing };
};

test("each actor calls each RPC once", async () => {
  tokens.A = await ownToken(0);
  tokens.B = await ownToken(1);
  // B's profile: the one write onboarding's first step makes, under B's own JWT. Teardown deletes B with it.
  const profile = object((await rpc("B", "start_onboarding", onboarding())).body);
  expect(profile?.ok, "run user B start_onboarding").toBe(true);
  for (const c of outcomeCases()) replies.outcome.push({ ...await rpc(c.actor, c.rpc, c.args), expected: c.expect });
  for (const c of validationCases()) replies.validation.push(await rpc(c.actor, c.rpc, c.args));
  for (const c of forbiddenCases()) replies.forbidden.push(await rpc(c.actor, c.rpc, c.args));
  for (const [name, args] of anonArgs()) replies.anon.push(await rpc("anon", name, args));
  for (const [name, args] of removedArgs()) replies.removed.push(await rpc("B", name, args));

  // Recorded findings for the coordinator, not assertions.
  const root = await wire("/rest/v1/", { method: "GET" });
  const named = KNOWN.filter(name => root.text.includes(`/rpc/${name}`));
  const unknown = async (actor: Actor) => {
    const value = await wire("/rest/v1/rpc/like_users", { method: "POST", body: { p_target: randomUUID() },
      jwt: actor === "anon" ? undefined : tokens[actor as "A" | "B"] });
    const body = object(value.body);
    const hint = typeof body?.hint === "string" ? body.hint : null;
    const functions = hint ? [...new Set([...hint.matchAll(/public\.([a-z_]+)/g)].map(match => match[1]))] : [];
    return { actor, status: value.status, code: body?.code ?? null, hint: hint !== null, hintNamesRealFunction: functions.some(name => KNOWN.includes(name)), functions };
  };
  evidence("postgrestShapes", {
    outcome: replies.outcome.map(brief), validation: replies.validation.map(brief), forbidden: replies.forbidden.map(brief),
    anon: replies.anon.map(brief), removed: replies.removed.map(brief),
    headers: { outcome: replies.outcome[0].headers, validation: replies.validation[0].headers, anon: replies.anon[0].headers },
    findings: {
      openApiRoot: { status: root.status, rpcPaths: (root.text.match(/"\/rpc\/[a-z_]+"/g) ?? []).length, namesKnownFunctions: named.length > 0 },
      unknownRpc: [await unknown("B"), await unknown("anon")],
    },
  });
});

test("outcome refusals share one shape apart from code", () => {
  const codes = new Set<string>();
  for (const reply of replies.outcome) {
    const label = `${reply.actor} ${reply.rpc}`;
    expect(reply.status, label).toBe(200);
    expect(object(reply.body) && Object.keys(object(reply.body)!).sort(), label).toEqual(["code", "ok", "ref"]);
    expect(reply.body, label).toEqual({ ok: false, code: reply.expected, ref: null });
    codes.add(reply.expected);
  }
  expect(codes.size).toBeGreaterThanOrEqual(2);
  const base = signature(replies.outcome[0], "code");
  for (const reply of replies.outcome) expect(signature(reply, "code"), `${reply.actor} ${reply.rpc}`).toBe(base);
});

test("validation exceptions share one status and body whatever the RPC", () => {
  expect(new Set(replies.validation.map(reply => reply.rpc)).size).toBeGreaterThanOrEqual(3);
  const first = replies.validation[0];
  expect(object(first.body) && Object.keys(object(first.body)!).sort()).toEqual(["code", "details", "hint", "message"]);
  expect(first.body).toEqual({ code: "P0001", message: "validation", details: null, hint: null });
  // Nothing may differ, the message included.
  const base = signature(first, "");
  for (const reply of replies.validation) expect(signature(reply, ""), `${reply.actor} ${reply.rpc}`).toBe(base);
});

test("forbidden exceptions match each other and validation's shape apart from message", () => {
  const first = replies.forbidden[0];
  expect(first.body).toEqual({ code: "P0001", message: "forbidden", details: null, hint: null });
  // No profile (A complete_profile, end_connection) and no staff role (admin_*) answer the same.
  const base = signature(first, "");
  for (const reply of replies.forbidden) expect(signature(reply, ""), `${reply.actor} ${reply.rpc}`).toBe(base);
  expect(signature(first, "message")).toBe(signature(replies.validation[0], "message"));
});

test("anon is refused identically for every RPC", () => {
  const first = replies.anon[0];
  expect([401, 403]).toContain(first.status);
  expect(object(first.body)?.code).toBe("42501");
  // The message may name the called function; the caller already knows it, so only that name is masked.
  const masked = (reply: Reply) => {
    const body = object(reply.body);
    const message = typeof body?.message === "string" ? body.message.split(reply.rpc).join("<rpc>") : body?.message;
    return signature({ ...reply, body: body ? { ...body, message } : reply.body }, "");
  };
  const base = masked(first);
  for (const reply of replies.anon) expect(masked(reply), reply.rpc).toBe(base);
});

test("a rate_limited refusal has the outcome shape apart from code", async () => {
  // C is created here, so A's and B's limits stay untouched. Its rate_limit_events rows stay under the deleted id.
  await createRunUsers(1);
  tokens.C = await ownToken(readState().users.length - 1);
  let limited: Reply | null = null;
  let calls = 0;
  const earlier: unknown[] = [];
  while (calls < 12 && !limited) {
    const reply = await rpc("C", "reserve_mfa_attempt", {});
    calls++;
    if (object(reply.body)?.code === "rate_limited") limited = reply;
    else earlier.push(object(reply.body)?.ok ?? null);
  }
  const base = replies.outcome.find(reply => reply.expected === "not_available")!;
  const body = limited ? object(limited.body) : null;
  evidence("postgrestRateLimited", {
    calls, limited: limited ? brief(limited) : null, earlierOk: earlier.every(ok => ok === true),
    headers: { rateLimited: limited?.headers ?? null, notAvailable: base.headers },
    keys: { rateLimited: body ? Object.keys(body).sort() : null, notAvailable: Object.keys(object(base.body)!).sort() },
    matched: limited ? signature(limited, "code") === signature(base, "code") : false,
  });
  expect(limited, `rate_limited within 12 calls (made ${calls})`).not.toBeNull();
  expect(calls).toBeLessThanOrEqual(12);
  expect(earlier.every(ok => ok === true), "calls before the limit succeed").toBe(true);
  expect(limited!.status).toBe(200);
  expect(limited!.body).toEqual({ ok: false, code: "rate_limited", ref: null });
  expect(signature(limited!, "code")).toBe(signature(base, "code"));
});

test("the RPCs order 34 dropped are not found", () => {
  expect(replies.removed.map(reply => reply.rpc)).toEqual(removedArgs().map(([rpc]) => rpc));
  for (const reply of replies.removed) {
    expect([reply.status, object(reply.body)?.code], reply.rpc).toEqual([404, "PGRST202"]);
  }
});
