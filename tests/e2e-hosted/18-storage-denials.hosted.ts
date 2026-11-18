import { test, expect } from "@playwright/test";
import { randomBytes, randomUUID } from "node:crypto";
import { ownedUser } from "./lifecycle";
import { environment, evidence, readState, saveState, type StorageObject } from "./state";
import { BUCKETS, cleanupStorageFixtures, listFolder, storageAdmin } from "./teardown";

// TEST-014, its own invocation (CAMPUS_E2E_STORAGE=1): Storage refuses a user's own JWT, another user's JWT and anon for
// every operation on both buckets (NT-20). Plain HTTP to /storage/v1/* with no browser and no app server. profile-photos
// has no user policy and verification-documents only the insert policy, which holds only in upload mode (hosted runs
// synthetic). Run user 0 (U) owns the fixtures and run user 1 (V) is another user; each signs in with its own password and
// the tokens stay in this module. The server key (teardown.ts) is used only to put one fictional WebP per bucket at
// <U id>/<random>.webp, for the read-back and for cleanup. Every name a probe could create is saved in the ledger first,
// so cleanup deletes exact names only. A refusal is a non-2xx status; list, bulk sign and bulk delete answer 2xx through
// RLS filtering, which passes only when it names, signs or deletes nothing. No reply may carry the fixture bytes or a
// signed URL. Evidence keeps bucket and actor labels, operations, statuses and codes only: never a token, key, email,
// signed URL or object path.
test.describe.configure({ mode: "serial" });

type Actor = "U" | "V" | "anon";
type Bucket = StorageObject["bucket"];
type Outcome = "refused" | "filtered" | "succeeded";
type Result = { bucket: string; op: string; actor: Actor; status: number; code: string | null; statusCode: string | null;
  outcome: Outcome; fixtureBytes: boolean; signedUrl: boolean; location: boolean };
type Fixture = { name: string; bytes: Buffer; marker: Buffer; size: number; eTag: string };

const ACTORS: Actor[] = ["U", "V", "anon"];
const LABEL: Record<Bucket, string> = { "profile-photos": "photo", "verification-documents": "document" };
// 2xx is a refusal only when the RLS-filtered answer is empty (no names, no signed URL, nothing deleted).
const FILTERED = new Set(["list", "sign-bulk", "delete-bulk"]);
// Cases hosted actually allowed: each stays asserted and is marked test.fail with a comment (none so far).
const FINDINGS = new Set<string>();
const OPS = ["get", "get-authenticated", "get-public", "info", "sign", "sign-long", "sign-bulk", "list", "render",
  "upload", "upload-sign", "overwrite-put", "overwrite-upsert", "delete", "delete-bulk", "move", "copy", "tus"] as const;
type Op = typeof OPS[number];

// A 1x1 lossless WebP with one extra chunk of random bytes, so the fixture's bytes are unique to this run.
const BASE = Buffer.from("UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==", "base64");
const u32 = (value: number) => { const buffer = Buffer.alloc(4); buffer.writeUInt32LE(value); return buffer; };
function webp(marker: Buffer) {
  const body = Buffer.concat([BASE.subarray(8), Buffer.from("XE2E"), u32(marker.length), marker]);
  return Buffer.concat([Buffer.from("RIFF"), u32(body.length), body]);
}

const env = () => {
  const value = environment();
  const key = value.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? value.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!key) throw new Error("Missing hosted public credential");
  return { url: value.NEXT_PUBLIC_SUPABASE_URL, key };
};
const tokens: Record<"U" | "V", string> = { U: "", V: "" };
async function ownToken(index: number): Promise<string> {
  const user = readState().users[index];
  const { url, key } = env();
  let data: { access_token?: unknown; user?: { id?: unknown } } | null = null;
  let status = 0;
  try {
    const response = await fetch(`${url}/auth/v1/token?grant_type=password`, { method: "POST", signal: AbortSignal.timeout(30_000),
      headers: { apikey: key, "Content-Type": "application/json" }, body: JSON.stringify({ email: user.email, password: user.password }) });
    status = response.status;
    data = await response.json();
  } catch { /* checked below */ }
  if (status !== 200 || data?.user?.id !== user.id || typeof data?.access_token !== "string") throw new Error("Hosted run-user sign-in failed (details suppressed)");
  return data.access_token;
}
type Sent = { status: number; raw: Buffer; location: string | null };
async function wire(actor: Actor, path: string, init: { method: string; json?: unknown; bytes?: Buffer; headers?: Record<string, string> }): Promise<Sent> {
  const { url, key } = env();
  const headers: Record<string, string> = { apikey: key, ...(actor === "anon" ? {} : { Authorization: `Bearer ${tokens[actor]}` }),
    ...(init.json === undefined ? {} : { "Content-Type": "application/json" }), ...init.headers };
  try {
    const response = await fetch(path.startsWith("https://") ? path : `${url}/storage/v1${path}`, {
      method: init.method, headers, redirect: "manual", signal: AbortSignal.timeout(30_000),
      body: init.json !== undefined ? JSON.stringify(init.json) : init.bytes ? new Uint8Array(init.bytes) : undefined,
    });
    return { status: response.status, raw: Buffer.from(await response.arrayBuffer()), location: response.headers.get("location") };
  } catch { throw new Error("Hosted Storage transport failed (details suppressed)"); }
}

const fixtures = {} as Record<Bucket, Fixture>;
// Per bucket and actor: the names a write probe would create. Move and copy target the actor's own folder (anon: U's).
const plans = {} as Record<Bucket, Record<Actor, Record<"upload" | "upload-sign" | "tus" | "move" | "copy", string>>>;
const results = new Map<string, Result>();
const caseKey = (bucket: Bucket, op: Op, actor: Actor) => `${LABEL[bucket]} ${op} ${actor}`;

const object = (value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const safe = (value: unknown) => typeof value === "number" ? String(value)
  : typeof value === "string" ? (/^[A-Za-z0-9][A-Za-z0-9_ ]{0,59}$/.test(value) ? value : "unclassified") : null;
const issued = (value: unknown): boolean => Array.isArray(value) ? value.some(issued)
  : object(value) ? Object.entries(object(value)!).some(([name, item]) =>
    (/^(signedURL|signedUrl|url|token)$/.test(name) && typeof item === "string" && item.length > 0) || issued(item)) : false;
function classify(bucket: Bucket, op: Op, actor: Actor, sent: Sent): Result {
  const text = sent.raw.toString("utf8");
  let body: unknown = null;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  const fixtureBytes = Object.values(fixtures).some(({ marker }) => sent.raw.includes(marker) ||
    [marker.toString("hex"), marker.toString("base64"), marker.toString("base64url")].some(encoded => text.includes(encoded)));
  const signedUrl = /[?&]token=/.test(text) || issued(body);
  const ok = sent.status >= 200 && sent.status < 300;
  const empty = FILTERED.has(op) && Array.isArray(body) &&
    (op === "sign-bulk" ? body.every(item => object(item) && !object(item)!.signedURL && !object(item)!.signedUrl) : body.length === 0);
  return { bucket: LABEL[bucket], op, actor, status: sent.status, code: safe(object(body)?.code ?? object(body)?.error),
    statusCode: safe(object(body)?.statusCode), outcome: !ok ? "refused" : empty ? "filtered" : "succeeded",
    fixtureBytes, signedUrl, location: sent.location !== null };
}

function request(bucket: Bucket, op: Op, actor: Actor, owner: { U: string; V: string }) {
  const fixture = fixtures[bucket].name;
  const plan = plans[bucket][actor];
  const attack = webp(randomBytes(32));
  const upload = { "Content-Type": "image/webp" };
  const b64 = (value: string) => Buffer.from(value).toString("base64");
  switch (op) {
    case "get": return wire(actor, `/object/${bucket}/${fixture}`, { method: "GET" });
    case "get-authenticated": return wire(actor, `/object/authenticated/${bucket}/${fixture}`, { method: "GET" });
    case "get-public": return wire(actor, `/object/public/${bucket}/${fixture}`, { method: "GET" });
    case "info": return wire(actor, `/object/info/authenticated/${bucket}/${fixture}`, { method: "GET" });
    case "sign": return wire(actor, `/object/sign/${bucket}/${fixture}`, { method: "POST", json: { expiresIn: 60 } });
    case "sign-long": return wire(actor, `/object/sign/${bucket}/${fixture}`, { method: "POST", json: { expiresIn: 31_536_000 } });
    case "sign-bulk": return wire(actor, `/object/sign/${bucket}`, { method: "POST", json: { expiresIn: 60, paths: [fixture] } });
    case "list": return wire(actor, `/object/list/${bucket}`, { method: "POST", json: { prefix: `${owner.U}/`, limit: 100 } });
    case "render": return wire(actor, `/render/image/authenticated/${bucket}/${fixture}?width=8&height=8`, { method: "GET" });
    case "upload": return wire(actor, `/object/${bucket}/${plan.upload}`, { method: "POST", bytes: attack, headers: { ...upload, "x-upsert": "false" } });
    case "upload-sign": return wire(actor, `/object/upload/sign/${bucket}/${plan["upload-sign"]}`, { method: "POST", json: {} });
    case "overwrite-put": return wire(actor, `/object/${bucket}/${fixture}`, { method: "PUT", bytes: attack, headers: upload });
    case "overwrite-upsert": return wire(actor, `/object/${bucket}/${fixture}`, { method: "POST", bytes: attack, headers: { ...upload, "x-upsert": "true" } });
    case "delete": return wire(actor, `/object/${bucket}/${fixture}`, { method: "DELETE" });
    case "delete-bulk": return wire(actor, `/object/${bucket}`, { method: "DELETE", json: { prefixes: [fixture] } });
    case "move": return wire(actor, "/object/move", { method: "POST", json: { bucketId: bucket, sourceKey: fixture, destinationKey: plan.move } });
    case "copy": return wire(actor, "/object/copy", { method: "POST", json: { bucketId: bucket, sourceKey: fixture, destinationKey: plan.copy } });
    case "tus": return wire(actor, "/upload/resumable", { method: "POST", headers: { "Tus-Resumable": "1.0.0", "Upload-Length": String(attack.length),
      "x-upsert": "false", "Upload-Metadata": `bucketName ${b64(bucket)},objectName ${b64(plan.tus)},contentType ${b64("image/webp")}` } });
  }
}

test("fixtures: two run users and one fictional WebP per bucket", async () => {
  const state = readState();
  const owner = { U: ownedUser(state, 0).id, V: ownedUser(state, 1).id };
  tokens.U = await ownToken(0);
  tokens.V = await ownToken(1);
  const name = (folder: string) => `${folder}/${randomUUID()}.webp`;
  for (const bucket of BUCKETS) {
    const marker = randomBytes(32);
    fixtures[bucket] = { name: name(owner.U), bytes: webp(marker), marker, size: 0, eTag: "" };
    plans[bucket] = Object.fromEntries(ACTORS.map(actor => {
      const own = actor === "V" ? owner.V : owner.U;
      return [actor, { upload: name(owner.U), "upload-sign": name(owner.U), tus: name(owner.U), move: name(own), copy: name(own) }];
    })) as Record<Actor, Record<"upload" | "upload-sign" | "tus" | "move" | "copy", string>>;
  }
  // Ledger first: every name this file could create, so cleanup can delete exact names even after a crash.
  state.storage = { objects: BUCKETS.flatMap(bucket => [fixtures[bucket].name, ...ACTORS.flatMap(actor => Object.values(plans[bucket][actor]))]
    .map(objectName => ({ bucket, name: objectName }))) };
  saveState(state);
  for (const bucket of BUCKETS) {
    const fixture = fixtures[bucket];
    const put = await storageAdmin(`/object/${bucket}/${fixture.name}`, "POST", fixture.bytes, { "Content-Type": "image/webp", "x-upsert": "false" });
    expect(put.ok, `${LABEL[bucket]} fixture upload status ${put.status}`).toBe(true);
    const listed = (await listFolder(bucket, owner.U)).find(item => `${owner.U}/${item.name}` === fixture.name);
    expect(typeof listed?.metadata?.eTag === "string" && typeof listed.metadata.size === "number", `${LABEL[bucket]} fixture listed`).toBe(true);
    fixture.size = listed!.metadata!.size as number;
    fixture.eTag = listed!.metadata!.eTag as string;
    expect(fixture.size, `${LABEL[bucket]} fixture size`).toBe(fixture.bytes.length);
  }
});

test("probe: every operation by U, V and anon on both buckets", async () => {
  test.setTimeout(600_000);
  const state = readState();
  const owner = { U: ownedUser(state, 0).id, V: ownedUser(state, 1).id };
  const { url } = env();
  for (const bucket of BUCKETS) for (const op of OPS) for (const actor of ACTORS) {
    const sent = await request(bucket, op, actor, owner);
    const result = classify(bucket, op, actor, sent);
    results.set(caseKey(bucket, op, actor), result);
    // A created resumable upload is a finding: terminate it at once (it holds no object until completed).
    if (op === "tus" && result.outcome === "succeeded" && sent.location?.startsWith(`${url}/storage/v1/`)) {
      await wire(actor, sent.location, { method: "DELETE", headers: { "Tus-Resumable": "1.0.0" } });
    }
  }
  evidence("storageDenials", {
    cases: [...results.values()],
    counts: { total: results.size, refused: [...results.values()].filter(r => r.outcome === "refused").length,
      filtered: [...results.values()].filter(r => r.outcome === "filtered").length,
      succeeded: [...results.values()].filter(r => r.outcome === "succeeded").length },
    notTried: [
      "S3-compatible access: needs S3 access keys generated in the dashboard, a separate credential this suite does not hold",
      "TUS PATCH/HEAD and signed-upload-token PUT: no upload or token was issued to continue",
      "bucket management endpoints: out of scope and would change bucket settings if allowed",
      "verification-documents insert in upload mode: hosted runs synthetic and app_settings are not changed",
      "app /media/photos route: needs the app server; covered by the default and visibility groups",
    ],
  });
});

test("read-back: both fixtures unchanged and no other object in U's or V's folder", async () => {
  const state = readState();
  const owner = { U: ownedUser(state, 0).id, V: ownedUser(state, 1).id };
  const readBack: Record<string, unknown>[] = [];
  for (const bucket of BUCKETS) {
    const fixture = fixtures[bucket];
    const inU = await listFolder(bucket, owner.U);
    const inV = await listFolder(bucket, owner.V);
    const listed = inU.find(item => `${owner.U}/${item.name}` === fixture.name);
    const download = await storageAdmin(`/object/authenticated/${bucket}/${fixture.name}`);
    const bytes = download.ok ? Buffer.from(await download.arrayBuffer()) : Buffer.alloc(0);
    const row = { bucket: LABEL[bucket], exists: listed !== undefined, sameSize: listed?.metadata?.size === fixture.size,
      sameETag: listed?.metadata?.eTag === fixture.eTag, sameBytes: bytes.equals(fixture.bytes), objectsInU: inU.length, objectsInV: inV.length };
    readBack.push(row);
    evidence("storageReadBack", readBack);
    expect(row.exists, `${LABEL[bucket]} fixture exists`).toBe(true);
    expect(row.sameSize, `${LABEL[bucket]} fixture size`).toBe(true);
    expect(row.sameETag, `${LABEL[bucket]} fixture etag`).toBe(true);
    expect(row.sameBytes, `${LABEL[bucket]} fixture bytes`).toBe(true);
    expect(row.objectsInU, `${LABEL[bucket]} objects under U`).toBe(1);
    expect(row.objectsInV, `${LABEL[bucket]} objects under V`).toBe(0);
  }
});

for (const bucket of BUCKETS) for (const op of OPS) for (const actor of ACTORS) {
  const title = caseKey(bucket, op, actor);
  test(`refused: ${title}`, () => {
    if (FINDINGS.has(title)) test.fail();
    const result = results.get(title);
    expect(result, `${title} probed`).toBeDefined();
    expect(result!.outcome, title).not.toBe("succeeded");
    expect(result!.fixtureBytes, `${title} fixture bytes`).toBe(false);
    expect(result!.signedUrl, `${title} signed URL`).toBe(false);
  });
}

test.afterAll(async () => {
  await cleanupStorageFixtures();
});
