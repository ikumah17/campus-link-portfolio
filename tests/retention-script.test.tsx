// @vitest-environment node
// RETENTION-001: scripts/maintenance/retention.mjs with fetch mocked (no network).
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

interface Candidate { kind: string; user_id: string; submission_id: string | null; storage_path: string | null }
interface Options { argv?: string[]; env?: Record<string, string>; envFile?: string; fetch?: typeof fetch; log?: (line: string) => void; now?: () => number }
type Run = (options: Options) => Promise<number>;

const REF = "abcdefghijklmnopqrst";
const URL_ = `https://${REF}.supabase.co`;
const KEY = `sb_secret_${"Zq9".repeat(12)}`;
const ENV = { NEXT_PUBLIC_SUPABASE_URL: URL_, SUPABASE_SERVICE_ROLE_KEY: KEY };

const docUser = randomUUID();
const submission = randomUUID();
const gone = randomUUID();
const goneSubmission = randomUUID();
const other = randomUUID();
const docPaths = [`${docUser}/${randomUUID()}.webp`, `${docUser}/doc/${randomUUID()}.webp`];
const photo = `${gone}/${randomUUID()}.webp`;
const goneDoc = `${gone}/${randomUUID()}.webp`;
// the server's order: accounts first, each account's own row after its objects
const CANDIDATES: Candidate[] = [
  { kind: "account", user_id: gone, submission_id: null, storage_path: photo },
  { kind: "account", user_id: gone, submission_id: goneSubmission, storage_path: goneDoc },
  { kind: "account", user_id: gone, submission_id: null, storage_path: null },
  { kind: "account", user_id: other, submission_id: null, storage_path: null },
  ...docPaths.map((p) => ({ kind: "document", user_id: docUser, submission_id: submission, storage_path: p })),
];
// RETENTION-003: orphan photos (no profile_photos row) come after the documents; one sits in a due account's folder
const orphanUser = randomUUID();
const orphanPaths = [`${gone}/${randomUUID()}.webp`, `${orphanUser}/${randomUUID()}.webp`, `${orphanUser}/n/${randomUUID()}.webp`];
const orphanRow = (p: string): Candidate => ({ kind: "orphan_photo", user_id: p.slice(0, 36), submission_id: null, storage_path: p });
const WITH_ORPHANS: Candidate[] = [...CANDIDATES, ...orphanPaths.map(orphanRow)];
// RETENTION-004: orphan documents (no submission names them) sort before the orphan photos
const orphanDocUser = randomUUID();
const orphanDocPaths = [`${gone}/${randomUUID()}.webp`, `${orphanDocUser}/${randomUUID()}.webp`, `${orphanDocUser}/d/${randomUUID()}.webp`];
const orphanDocRow = (p: string): Candidate => ({ kind: "orphan_document", user_id: p.slice(0, 36), submission_id: null, storage_path: p });
const WITH_ORPHAN_DOCS: Candidate[] = [...CANDIDATES, ...orphanDocPaths.map(orphanDocRow), ...orphanPaths.map(orphanRow)];

interface Call { method: string; path: string; body: unknown; headers: Record<string, string> }
/** one candidate response: the rows sent and the exact count in Content-Range (null: no header) */
interface Page { rows: unknown; total?: number | null }

function listing({ rows, total }: Page) {
  const n = Array.isArray(rows) ? rows.length : 0;
  const count = total === undefined ? n : total;
  const headers = count === null ? undefined : { "Content-Range": n ? `0-${n - 1}/${count}` : `*/${count}` };
  return Response.json(rows, { headers });
}

function mockFetch(options: { candidates?: unknown; pages?: Page[]; fail?: string; purged?: unknown; missingStorage?: boolean } = {}) {
  const calls: Call[] = [];
  let listed = 0;
  const impl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    expect(url.startsWith(`${URL_}/`)).toBe(true);
    const path = url.slice(URL_.length);
    calls.push({ method: init?.method ?? "GET", path, body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: init?.headers as Record<string, string> });
    if (options.fail && path.startsWith(options.fail)) return new Response(JSON.stringify({ message: "boom" }), { status: 500 });
    if (path === "/rest/v1/rpc/service_retention_candidates") {
      const pages = options.pages ?? [{ rows: options.candidates ?? CANDIDATES }];
      return listing(pages[Math.min((listed += 1) - 1, pages.length - 1)]);
    }
    if (path === "/rest/v1/rpc/service_purge_rate_limits") return Response.json(options.purged ?? 4);
    if (path.startsWith("/storage/v1/object/")) return Response.json(options.missingStorage ? [] : (calls.at(-1)!.body as { prefixes: string[] }).prefixes.map((name) => ({ name })));
    if (path.startsWith("/auth/v1/admin/users/")) return Response.json({});
    throw new Error(`unexpected ${path}`);
  };
  return { calls, fetch: impl as typeof fetch };
}

let run: Run;
let dir: string;
const noFile = () => join(dir, "missing.env");

async function sweep(argv: string[], fetchMock = mockFetch(), env: Record<string, string> = ENV, envFile = noFile(), now?: () => number) {
  const lines: string[] = [];
  const code = await run({ argv, env, envFile, fetch: fetchMock.fetch, log: (l) => lines.push(l), now });
  const output = lines.join("\n");
  expect(output).not.toContain(KEY);
  expect(output).not.toContain("Zq9Zq9");
  for (const p of [...docPaths, photo, goneDoc, ...orphanPaths, orphanUser, ...orphanDocPaths, orphanDocUser]) expect(output).not.toContain(p);
  expect(output).not.toMatch(/@|example\.invalid/);
  return { code, output, lines, calls: fetchMock.calls, summary: JSON.parse(lines.at(-1)!) };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "retention-test-"));
  const href = new URL("../scripts/maintenance/retention.mjs", import.meta.url).href;
  ({ run } = (await import(/* @vite-ignore */ href)) as { run: Run });
});
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

describe("RETENTION-001 retention script", () => {
  it("dry run (the default) reads the candidates only, and prints counts and ids", async () => {
    const r = await sweep([]);
    expect(r.code).toBe(0);
    expect(r.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /rest/v1/rpc/service_retention_candidates"]);
    expect(r.calls.filter((c) => c.method === "DELETE")).toEqual([]);
    expect(r.calls[0].headers).toMatchObject({ apikey: KEY, Authorization: `Bearer ${KEY}`, Prefer: "count=exact" });
    expect(r.output).toContain("document: 2 object(s) in 1 submission(s)");
    expect(r.output).toContain("account: 2 account(s), 2 object(s)");
    expect(r.output).toContain("orphan photo: 0 object(s)");
    expect(r.output).toContain("orphan document: 0 object(s)");
    for (const id of [submission, gone, other]) expect(r.output).toContain(id);
    expect(r.summary).toEqual({ p_now: expect.any(String), skipped_reviewers: 0, ok: true, mode: "dry-run", project: REF, truncated: false,
      documents: { submissions: 1, objects: 2 }, accounts: { users: 2, objects: 2 }, orphans: { objects: 0 },
      orphan_documents: { objects: 0 }, done: null });
  });

  it("dry run counts orphan photos on their own line and prints no orphan path or folder", async () => {
    const r = await sweep([], mockFetch({ candidates: WITH_ORPHANS }));
    expect(r.code).toBe(0);
    expect(r.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /rest/v1/rpc/service_retention_candidates"]);
    expect(r.lines).toContain("orphan photo: 3 object(s)");
    expect(r.output).toContain("account: 2 account(s), 2 object(s)");
    expect(r.summary).toMatchObject({ ok: true, mode: "dry-run", orphans: { objects: 3 }, accounts: { users: 2, objects: 2 },
      documents: { submissions: 1, objects: 2 }, done: null });
  });

  it("--apply deletes orphan photos in the Storage step with the account photos, before documents and Auth", async () => {
    const r = await sweep(["--apply", "--confirm", REF], mockFetch({ candidates: WITH_ORPHANS }));
    expect(r.code).toBe(0);
    expect(r.calls.map(({ method, path, body }) => ({ method, path, body }))).toEqual([
      { method: "POST", path: "/rest/v1/rpc/service_retention_candidates", body: { p_now: r.summary.p_now } },
      { method: "DELETE", path: "/storage/v1/object/profile-photos", body: { prefixes: [photo, ...orphanPaths] } },
      { method: "DELETE", path: "/storage/v1/object/verification-documents", body: { prefixes: [goneDoc, ...docPaths] } },
      ...[gone, other].sort().map((id) => ({ method: "DELETE", path: `/auth/v1/admin/users/${id}`, body: undefined })),
      { method: "POST", path: "/rest/v1/rpc/service_purge_rate_limits", body: { p_now: r.summary.p_now } },
    ]);
    expect(r.calls.some((c) => c.path === `/auth/v1/admin/users/${orphanUser}`)).toBe(false);
    expect(r.summary).toMatchObject({ ok: true, orphans: { objects: 3 },
      done: { batches: 1, photoObjects: 4, documentObjects: 3, accounts: 2, rateLimitsPurged: 4 } });
  });

  it("orphan photos go through the same batched delete, 100 per request", async () => {
    const many = Array.from({ length: 150 }, () => orphanRow(`${orphanUser}/${randomUUID()}.webp`));
    const r = await sweep(["--apply", "--confirm", REF], mockFetch({ candidates: many }));
    expect(r.code).toBe(0);
    const deletes = r.calls.filter((c) => c.method === "DELETE");
    expect(deletes.map((c) => c.path)).toEqual(Array(2).fill("/storage/v1/object/profile-photos"));
    expect(deletes.map((c) => (c.body as { prefixes: string[] }).prefixes)).toEqual([
      many.slice(0, 100).map((x) => x.storage_path), many.slice(100).map((x) => x.storage_path)]);
    for (const x of many) expect(r.output).not.toContain(x.storage_path!);
    expect(r.summary).toMatchObject({ ok: true, orphans: { objects: 150 }, done: { photoObjects: 150, accounts: 0 } });
  });

  it("a failing orphan photo delete stops before documents, Auth and the purge", async () => {
    const r = await sweep(["--apply", "--confirm", REF], mockFetch({ candidates: WITH_ORPHANS, fail: "/storage/v1/object/profile-photos" }));
    expect(r.code).toBe(1);
    expect(r.calls.map((c) => c.path)).toEqual(["/rest/v1/rpc/service_retention_candidates", "/storage/v1/object/profile-photos"]);
    expect(r.summary).toMatchObject({ ok: false, failed: "storage:profile-photos", status: 500,
      done: { photoObjects: 0, documentObjects: 0, accounts: 0, rateLimitsPurged: null } });
    const missing = await sweep(["--apply", "--confirm", REF], mockFetch({ candidates: orphanPaths.map(orphanRow), missingStorage: true }));
    expect(missing.code).toBe(1);
    expect(missing.summary).toMatchObject({ ok: false, failed: "storage:profile-photos" });
    expect(missing.calls.some((c) => c.path.includes("purge"))).toBe(false);
  });

  it("an unexpected orphan row stops the run before any delete", async () => {
    for (const bad of [
      { ...orphanRow(orphanPaths[1]), submission_id: randomUUID() },
      { ...orphanRow(orphanPaths[1]), storage_path: null },
      { ...orphanRow(orphanPaths[1]), user_id: gone },
      { ...orphanRow(orphanPaths[1]), user_id: orphanUser.toUpperCase() },
      orphanRow(`${orphanUser}/../${randomUUID()}.webp`),
      orphanRow(`${orphanUser}/${randomUUID()}.png`),
    ]) {
      const r = await sweep(["--apply", "--confirm", REF], mockFetch({ candidates: [...WITH_ORPHANS, bad] }));
      expect(r.code, JSON.stringify(bad)).toBe(1);
      expect(r.calls.filter((c) => c.method === "DELETE")).toEqual([]);
    }
    // an account row after an orphan row is out of the server's order
    const r = await sweep(["--apply", "--confirm", REF], mockFetch({ candidates: [orphanRow(orphanPaths[1]), CANDIDATES[3]] }));
    expect(r.code).toBe(1);
    expect(r.calls.filter((c) => c.method === "DELETE")).toEqual([]);
  });

  it("pins the same time across all batches and purge", async () => {
    const r = await sweep(["--apply", "--confirm", REF], mockFetch({ pages: [
      { rows: CANDIDATES.slice(0, 3), total: CANDIDATES.length }, { rows: CANDIDATES.slice(3) },
    ] }));
    expect(r.code).toBe(0);
    const bodies = r.calls.filter((c) => c.path.includes("/rpc/")).map((c) => c.body);
    expect(bodies).toHaveLength(3);
    expect(bodies).toEqual(Array(3).fill({ p_now: r.summary.p_now }));
    expect(Number.isFinite(Date.parse(r.summary.p_now))).toBe(true);
  });

  it("FIX-003: p_now is 60 s before the clock, read once and sent to every listing and the purge", async () => {
    const clock = Date.parse("2026-11-16T12:00:00.000Z");
    let reads = 0;
    const r = await sweep(["--apply", "--confirm", REF], mockFetch({ pages: [
      { rows: CANDIDATES.slice(0, 3), total: CANDIDATES.length }, { rows: CANDIDATES.slice(3) },
    ] }), ENV, noFile(), () => { reads += 1; return clock; });
    expect(r.code).toBe(0);
    expect(reads).toBe(1);
    expect(r.summary.p_now).toBe("2026-11-16T11:59:00.000Z");
    const rpc = r.calls.filter((c) => c.path.includes("/rpc/"));
    expect(rpc.map((c) => c.path)).toEqual([
      "/rest/v1/rpc/service_retention_candidates", "/rest/v1/rpc/service_retention_candidates", "/rest/v1/rpc/service_purge_rate_limits",
    ]);
    expect(rpc.map((c) => c.body)).toEqual(Array(3).fill({ p_now: "2026-11-16T11:59:00.000Z" }));
  });

  it("FIX-003: a dry run with the real clock sends a p_now at least 60 s in the past", async () => {
    const before = Date.now();
    const r = await sweep([]);
    const after = Date.now();
    expect(r.code).toBe(0);
    const sent = Date.parse((r.calls[0].body as { p_now: string }).p_now);
    expect(r.summary.p_now).toBe((r.calls[0].body as { p_now: string }).p_now);
    expect(sent).toBeGreaterThanOrEqual(before - 60_000);
    expect(sent).toBeLessThanOrEqual(after - 60_000);
  });

  it("stops before Auth when Storage omits a requested path", async () => {
    const r = await sweep(["--apply", "--confirm", REF], mockFetch({ missingStorage: true }));
    expect(r.code).toBe(1);
    expect(r.calls.some((c) => c.path.startsWith("/auth/"))).toBe(false);
    expect(r.summary.failed).toBe("storage:profile-photos");
  });

  it("counts former reviewers without deleting them", async () => {
    const r = await sweep(["--apply", "--confirm", REF], mockFetch({ candidates: [
      ...CANDIDATES, { kind: "skipped_reviewer", user_id: docUser, submission_id: null, storage_path: null },
    ] }));
    expect(r.code).toBe(0);
    expect(r.summary.skipped_reviewers).toBe(1);
    expect(r.output).toContain(`skipped reviewer ${docUser}`);
    expect(r.calls.some((c) => c.path === `/auth/v1/admin/users/${docUser}`)).toBe(false);
  });

  it("rejects split accounts and account rows preceding their objects before deletion", async () => {
    for (const rows of [
      [CANDIDATES[0], CANDIDATES[3], CANDIDATES[1], CANDIDATES[2]],
      [CANDIDATES[2], CANDIDATES[0]],
      [CANDIDATES[0], CANDIDATES[4], CANDIDATES[2]],
      [CANDIDATES[4], CANDIDATES[0], CANDIDATES[1], CANDIDATES[2]],
    ]) {
      const r = await sweep(["--apply", "--confirm", REF], mockFetch({ candidates: rows }));
      expect(r.code).toBe(1);
      expect(r.calls.filter((c) => c.method === "DELETE")).toEqual([]);
    }
  });

  it("--apply without the matching --confirm refuses before any request", async () => {
    for (const argv of [["--apply"], ["--apply", "--confirm", "zzzzzzzzzzzzzzzzzzzz"], ["--apply", `--confirm=${REF}x`], ["--apply", "--confirm"]]) {
      const r = await sweep(argv);
      expect(r.code, argv.join(" ")).toBe(2);
      expect(r.calls).toEqual([]);
      expect(r.summary.ok).toBe(false);
    }
  });

  it("refuses unknown arguments, an unexpected URL and a missing or non-server key", async () => {
    for (const [argv, env] of [
      [["--force"], ENV],
      [[], { ...ENV, NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321" }],
      [[], { ...ENV, NEXT_PUBLIC_SUPABASE_URL: `https://${REF}.supabase.co.evil.test` }],
      [[], { NEXT_PUBLIC_SUPABASE_URL: URL_ }],
      [[], { ...ENV, SUPABASE_SERVICE_ROLE_KEY: "sb_publishable_abc" }],
    ] as const) {
      const r = await sweep([...argv], mockFetch(), { ...env });
      expect(r.code).toBe(2);
      expect(r.calls).toEqual([]);
    }
  });

  it("reads the settings from .env.local when the environment has none", async () => {
    const file = join(dir, ".env.local");
    writeFileSync(file, `OTHER=1\r\nNEXT_PUBLIC_SUPABASE_URL=${URL_}\r\nSUPABASE_SERVICE_ROLE_KEY=${KEY}\r\n`);
    const r = await sweep([], mockFetch(), {}, file);
    expect(r.code).toBe(0);
    expect(r.calls[0].headers.apikey).toBe(KEY);
  });

  it("--apply --confirm <ref> deletes exactly the candidates: Storage, then Auth, then the rate-limit purge", async () => {
    const r = await sweep(["--apply", "--confirm", REF]);
    expect(r.code).toBe(0);
    expect(r.calls.map(({ method, path, body }) => ({ method, path, body }))).toEqual([
      { method: "POST", path: "/rest/v1/rpc/service_retention_candidates", body: { p_now: r.summary.p_now } },
      { method: "DELETE", path: "/storage/v1/object/profile-photos", body: { prefixes: [photo] } },
      { method: "DELETE", path: "/storage/v1/object/verification-documents", body: { prefixes: [goneDoc, ...docPaths] } },
      ...[gone, other].sort().map((id) => ({ method: "DELETE", path: `/auth/v1/admin/users/${id}`, body: undefined })),
      { method: "POST", path: "/rest/v1/rpc/service_purge_rate_limits", body: { p_now: r.summary.p_now } },
    ]);
    expect(r.summary).toMatchObject({ ok: true, mode: "apply", project: REF,
      done: { batches: 1, photoObjects: 1, documentObjects: 3, accounts: 2, rateLimitsPurged: 4 } });
  });

  // PostgREST cuts a set-returning RPC at db-max-rows without an error; the exact count shows the cut
  const first = `1${randomUUID().slice(1)}`;
  const cutUser = `2${randomUUID().slice(1)}`;
  const firstPhoto = `${first}/${randomUUID()}.webp`;
  const cutPhoto = `${cutUser}/${randomUUID()}.webp`;
  const cutDoc = `${cutUser}/${randomUUID()}.webp`;
  const cutRows: Candidate[] = [
    { kind: "account", user_id: cutUser, submission_id: null, storage_path: cutPhoto },
    { kind: "account", user_id: cutUser, submission_id: randomUUID(), storage_path: cutDoc },
    { kind: "account", user_id: cutUser, submission_id: null, storage_path: null },
  ];
  const full: Candidate[] = [
    { kind: "account", user_id: first, submission_id: null, storage_path: firstPhoto },
    { kind: "account", user_id: first, submission_id: null, storage_path: null },
    ...cutRows,
    ...docPaths.map((p) => ({ kind: "document", user_id: docUser, submission_id: submission, storage_path: p })),
  ];
  // the first response ends inside cutUser's rows: its photo arrived, its document and its own row did not
  const cutPages = (): Page[] => [{ rows: full.slice(0, 3), total: full.length }, { rows: full.slice(2) }];

  it("a listing cut inside an account deletes nothing of that account in that batch, then finishes it in the next", async () => {
    const r = await sweep(["--apply", "--confirm", REF], mockFetch({ pages: cutPages() }));
    expect(r.code).toBe(0);
    expect(r.calls.map(({ method, path, body }) => ({ method, path, body }))).toEqual([
      { method: "POST", path: "/rest/v1/rpc/service_retention_candidates", body: { p_now: r.summary.p_now } },
      { method: "DELETE", path: "/storage/v1/object/profile-photos", body: { prefixes: [firstPhoto] } },
      { method: "DELETE", path: `/auth/v1/admin/users/${first}`, body: undefined },
      { method: "POST", path: "/rest/v1/rpc/service_retention_candidates", body: { p_now: r.summary.p_now } },
      { method: "DELETE", path: "/storage/v1/object/profile-photos", body: { prefixes: [cutPhoto] } },
      { method: "DELETE", path: "/storage/v1/object/verification-documents", body: { prefixes: [cutDoc, ...docPaths] } },
      { method: "DELETE", path: `/auth/v1/admin/users/${cutUser}`, body: undefined },
      { method: "POST", path: "/rest/v1/rpc/service_purge_rate_limits", body: { p_now: r.summary.p_now } },
    ]);
    for (const p of [firstPhoto, cutPhoto, cutDoc]) expect(r.output).not.toContain(p);
    expect(r.summary).toMatchObject({ ok: true, truncated: true, accounts: { users: 2, objects: 3 },
      documents: { submissions: 1, objects: 2 }, done: { batches: 2, photoObjects: 2, documentObjects: 3, accounts: 2 } });
  });

  it("a cut listing whose second response fails stops with the cut account untouched", async () => {
    const r = await sweep(["--apply", "--confirm", REF],
      mockFetch({ pages: [{ rows: full.slice(0, 3), total: full.length }, { rows: full.slice(2), total: null }] }));
    expect(r.code).toBe(1);
    expect(r.calls.filter((c) => c.method === "DELETE").map((c) => c.path))
      .toEqual(["/storage/v1/object/profile-photos", `/auth/v1/admin/users/${first}`]);
    expect(r.calls.some((c) => JSON.stringify(c.body ?? "").includes(cutPhoto))).toBe(false);
    expect(r.summary).toMatchObject({ ok: false, failed: "candidates", done: { batches: 1, accounts: 1 } });
  });

  it("dry run of a cut listing reports the cut and deletes nothing", async () => {
    const r = await sweep([], mockFetch({ pages: cutPages() }));
    expect(r.code).toBe(0);
    expect(r.calls.map((c) => c.path)).toEqual(["/rest/v1/rpc/service_retention_candidates"]);
    expect(r.output).toContain(`candidates: 3 of ${full.length} row(s) in this listing`);
    expect(r.output).not.toContain(cutUser);
    expect(r.summary).toMatchObject({ ok: true, truncated: true, accounts: { users: 1, objects: 1 } });
  });

  it("a cut listing that holds only part of one account, or one that does not shrink, stops before any further delete", async () => {
    const part = await sweep(["--apply", "--confirm", REF],
      mockFetch({ pages: [{ rows: cutRows.slice(0, 2), total: cutRows.length }] }));
    expect(part.code).toBe(1);
    expect(part.calls.filter((c) => c.method === "DELETE")).toEqual([]);
    const stuck = await sweep(["--apply", "--confirm", REF],
      mockFetch({ pages: [{ rows: full.slice(0, 3), total: full.length }] }));
    expect(stuck.code).toBe(1);
    expect(stuck.calls.filter((c) => c.method === "DELETE").map((c) => c.path))
      .toEqual(["/storage/v1/object/profile-photos", `/auth/v1/admin/users/${first}`]);
    expect(stuck.summary).toMatchObject({ ok: false, failed: "candidates" });
  });

  it("a candidate response without an exact count, or with a count below its rows, stops before any delete", async () => {
    for (const total of [null, CANDIDATES.length - 1]) {
      const r = await sweep(["--apply", "--confirm", REF], mockFetch({ pages: [{ rows: CANDIDATES, total }] }));
      expect(r.code, String(total)).toBe(1);
      expect(r.calls.filter((c) => c.method === "DELETE")).toEqual([]);
      expect(r.summary).toMatchObject({ ok: false, failed: "candidates" });
    }
  });

  it("nothing due: apply deletes nothing and still purges the rate limits", async () => {
    const r = await sweep([`--confirm=${REF}`, "--apply"], mockFetch({ candidates: [] }));
    expect(r.code).toBe(0);
    expect(r.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /rest/v1/rpc/service_retention_candidates", "POST /rest/v1/rpc/service_purge_rate_limits"]);
  });

  it("a failing Storage delete stops before any Auth delete or purge", async () => {
    const r = await sweep(["--apply", "--confirm", REF], mockFetch({ fail: "/storage/v1/object/verification-documents" }));
    expect(r.code).toBe(1);
    expect(r.calls.map((c) => c.path)).toEqual([
      "/rest/v1/rpc/service_retention_candidates", "/storage/v1/object/profile-photos", "/storage/v1/object/verification-documents"]);
    expect(r.calls.some((c) => c.path.startsWith("/auth/"))).toBe(false);
    expect(r.summary).toMatchObject({ ok: false, failed: "storage:verification-documents", status: 500,
      done: { photoObjects: 1, documentObjects: 0, accounts: 0, rateLimitsPurged: null } });
  });

  it("a failing Auth delete stops before the purge; a network error stops too", async () => {
    const auth = await sweep(["--apply", "--confirm", REF], mockFetch({ fail: "/auth/v1/admin/users/" }));
    expect(auth.code).toBe(1);
    expect(auth.calls.filter((c) => c.path.startsWith("/auth/"))).toHaveLength(1);
    expect(auth.calls.some((c) => c.path.includes("purge"))).toBe(false);
    const broken = { calls: [] as Call[], fetch: (async () => { throw new Error(`fetch failed ${KEY}`); }) as typeof fetch };
    const net = await sweep(["--apply", "--confirm", REF], broken);
    expect(net.code).toBe(1);
    expect(net.summary).toMatchObject({ ok: false, failed: "candidates", status: null });
  });

  it("an unexpected candidate row stops the run before any delete", async () => {
    for (const bad of [
      { kind: "document", user_id: docUser, submission_id: submission, storage_path: `${other}/${randomUUID()}.webp` },
      { kind: "document", user_id: docUser, submission_id: submission, storage_path: `${docUser}/../x.webp` },
      { kind: "document", user_id: docUser, submission_id: submission, storage_path: `${docUser}/x.png` },
      { kind: "document", user_id: docUser, submission_id: null, storage_path: docPaths[0] },
      { kind: "account", user_id: other.toUpperCase(), submission_id: null, storage_path: null },
      { kind: "account", user_id: randomUUID(), submission_id: randomUUID(), storage_path: null },
      { kind: "purge", user_id: docUser, submission_id: null, storage_path: null },
    ]) {
      const r = await sweep(["--apply", "--confirm", REF], mockFetch({ candidates: [...CANDIDATES, bad] }));
      expect(r.code, JSON.stringify(bad)).toBe(1);
      expect(r.calls.filter((c) => c.method === "DELETE")).toEqual([]);
    }
    // an account's object without the account row itself
    const orphan = CANDIDATES.filter((c) => !(c.user_id === gone && c.storage_path === null));
    expect((await sweep(["--apply", "--confirm", REF], mockFetch({ candidates: orphan }))).code).toBe(1);
    expect((await sweep(["--apply", "--confirm", REF], mockFetch({ candidates: { rows: [] } }))).code).toBe(1);
  });
});

describe("RETENTION-004 orphan documents", () => {
  it("dry run counts orphan documents on their own line and prints no path or folder", async () => {
    const r = await sweep([], mockFetch({ candidates: WITH_ORPHAN_DOCS }));
    expect(r.code).toBe(0);
    expect(r.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /rest/v1/rpc/service_retention_candidates"]);
    expect(r.lines).toContain("orphan document: 3 object(s)");
    expect(r.lines).toContain("orphan photo: 3 object(s)");
    expect(r.output).toContain("document: 2 object(s) in 1 submission(s)");
    expect(r.summary).toMatchObject({ ok: true, mode: "dry-run", orphan_documents: { objects: 3 }, orphans: { objects: 3 },
      documents: { submissions: 1, objects: 2 }, accounts: { users: 2, objects: 2 }, done: null });
  });

  it("--apply deletes orphan documents from verification-documents in the Storage step, before Auth", async () => {
    const r = await sweep(["--apply", "--confirm", REF], mockFetch({ candidates: WITH_ORPHAN_DOCS }));
    expect(r.code).toBe(0);
    expect(r.calls.map(({ method, path, body }) => ({ method, path, body }))).toEqual([
      { method: "POST", path: "/rest/v1/rpc/service_retention_candidates", body: { p_now: r.summary.p_now } },
      { method: "DELETE", path: "/storage/v1/object/profile-photos", body: { prefixes: [photo, ...orphanPaths] } },
      { method: "DELETE", path: "/storage/v1/object/verification-documents", body: { prefixes: [goneDoc, ...docPaths, ...orphanDocPaths] } },
      ...[gone, other].sort().map((id) => ({ method: "DELETE", path: `/auth/v1/admin/users/${id}`, body: undefined })),
      { method: "POST", path: "/rest/v1/rpc/service_purge_rate_limits", body: { p_now: r.summary.p_now } },
    ]);
    expect(r.calls.some((c) => c.path === `/auth/v1/admin/users/${orphanDocUser}`)).toBe(false);
    expect(r.summary).toMatchObject({ ok: true, orphan_documents: { objects: 3 },
      done: { batches: 1, photoObjects: 4, documentObjects: 6, accounts: 2, rateLimitsPurged: 4 } });
  });

  it("orphan documents go through the same batched delete, 100 per request", async () => {
    const many = Array.from({ length: 150 }, () => orphanDocRow(`${orphanDocUser}/${randomUUID()}.webp`));
    const r = await sweep(["--apply", "--confirm", REF], mockFetch({ candidates: many }));
    expect(r.code).toBe(0);
    const deletes = r.calls.filter((c) => c.method === "DELETE");
    expect(deletes.map((c) => c.path)).toEqual(Array(2).fill("/storage/v1/object/verification-documents"));
    expect(deletes.map((c) => (c.body as { prefixes: string[] }).prefixes)).toEqual([
      many.slice(0, 100).map((x) => x.storage_path), many.slice(100).map((x) => x.storage_path)]);
    for (const x of many) expect(r.output).not.toContain(x.storage_path!);
    expect(r.summary).toMatchObject({ ok: true, orphan_documents: { objects: 150 }, done: { documentObjects: 150, accounts: 0 } });
  });

  it("a failing or incomplete orphan document delete stops before Auth and the purge", async () => {
    const r = await sweep(["--apply", "--confirm", REF],
      mockFetch({ candidates: WITH_ORPHAN_DOCS, fail: "/storage/v1/object/verification-documents" }));
    expect(r.code).toBe(1);
    expect(r.calls.map((c) => c.path)).toEqual([
      "/rest/v1/rpc/service_retention_candidates", "/storage/v1/object/profile-photos", "/storage/v1/object/verification-documents"]);
    expect(r.summary).toMatchObject({ ok: false, failed: "storage:verification-documents", status: 500,
      done: { photoObjects: 4, documentObjects: 0, accounts: 0, rateLimitsPurged: null } });
    const missing = await sweep(["--apply", "--confirm", REF], mockFetch({ candidates: orphanDocPaths.map(orphanDocRow), missingStorage: true }));
    expect(missing.code).toBe(1);
    expect(missing.summary).toMatchObject({ ok: false, failed: "storage:verification-documents" });
    expect(missing.calls.some((c) => c.path.startsWith("/auth/") || c.path.includes("purge"))).toBe(false);
  });

  it("an unexpected orphan document row stops the run before any delete", async () => {
    for (const bad of [
      { ...orphanDocRow(orphanDocPaths[1]), submission_id: randomUUID() },
      { ...orphanDocRow(orphanDocPaths[1]), storage_path: null },
      { ...orphanDocRow(orphanDocPaths[1]), user_id: gone },
      { ...orphanDocRow(orphanDocPaths[1]), user_id: orphanDocUser.toUpperCase() },
      orphanDocRow(`${orphanDocUser}/../${randomUUID()}.webp`),
      orphanDocRow(`${orphanDocUser}/${randomUUID()}.pdf`),
    ]) {
      const r = await sweep(["--apply", "--confirm", REF], mockFetch({ candidates: [...WITH_ORPHAN_DOCS, bad] }));
      expect(r.code, JSON.stringify(bad)).toBe(1);
      expect(r.calls.filter((c) => c.method === "DELETE")).toEqual([]);
    }
    // an account row after an orphan document row is out of the server's order
    const r = await sweep(["--apply", "--confirm", REF], mockFetch({ candidates: [orphanDocRow(orphanDocPaths[1]), CANDIDATES[3]] }));
    expect(r.code).toBe(1);
    expect(r.calls.filter((c) => c.method === "DELETE")).toEqual([]);
  });
});
