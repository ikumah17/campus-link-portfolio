// @vitest-environment node
import { beforeAll, describe, expect, it, vi } from "vitest";
import { parseSweep, projectRef, sweepCounts, sweepMismatch } from "./retention";

vi.mock("./lifecycle", () => ({ ownedUser: vi.fn() }));
vi.mock("./state", () => ({ environment: vi.fn(), readState: vi.fn() }));

const u = "12345678-1234-4123-8123-123456789abc";
const other = "22345678-1234-4123-8123-123456789abc";
const photo = (user: string) => ({ kind: "account", user_id: user, submission_id: null, storage_path: `${user}/32345678-1234-4123-8123-123456789abc.webp` });
const own = (user: string) => ({ kind: "account", user_id: user, submission_id: null, storage_path: null });
const env = { NEXT_PUBLIC_SUPABASE_URL: `https://${projectRef}.supabase.co`, SUPABASE_SERVICE_ROLE_KEY: "sb_" + "secret_unit_only_placeholder" };

type Run = (options: { argv: string[]; env: Record<string, string>; envFile: string; fetch: typeof fetch; log: (line: string) => void }) => Promise<number>;
let run: Run;
beforeAll(async () => {
  const href = new URL("../../scripts/maintenance/retention.mjs", import.meta.url).href;
  ({ run } = (await import(/* @vite-ignore */ href)) as { run: Run });
});

// Drives the real script with a fake provider, so the parser is checked against its actual output.
async function script(rows: unknown[], apply = false, failStorage = false) {
  let listings = 0;
  const fetch = vi.fn(async (url: string, options: RequestInit) => {
    const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });
    if (url.endsWith("/rpc/service_retention_candidates")) {
      const listed = listings++ ? [] : rows;
      return json(listed, 200, { "content-range": listed.length ? `0-${listed.length - 1}/${listed.length}` : "*/0" });
    }
    if (url.includes("/storage/v1/object/")) {
      if (failStorage) return json({}, 500);
      return json(JSON.parse(options.body as string).prefixes.map((name: string) => ({ name })));
    }
    if (url.includes("/auth/v1/admin/users/")) return json({});
    if (url.endsWith("/rpc/service_purge_rate_limits")) return json(3);
    throw new Error("unexpected request");
  });
  const lines: string[] = [];
  const exit = await run({ argv: apply ? ["--apply", "--confirm", projectRef] : [], env, envFile: "missing-unit-env-file", fetch: fetch as unknown as typeof globalThis.fetch, log: (line: string) => lines.push(line) });
  return parseSweep(exit, lines.join("\n"));
}

describe("hosted retention sweep checks", () => {
  it("accepts a dry run listing exactly the run account and its photo", async () => {
    const value = await script([photo(u), own(u)]);
    expect(sweepMismatch(value, "dry-run", { id: u, photos: 1 })).toBeNull();
    expect(sweepCounts(value)).toMatchObject({ exit: 0, ok: true, mode: "dry-run", project: projectRef, truncated: false,
      accounts: { users: 1, objects: 1 }, documents: { submissions: 0, objects: 0 }, skippedReviewers: 0, done: null, listedUsers: 1 });
    expect(JSON.stringify(sweepCounts(value))).not.toContain(u);
  });
  it("refuses any other listing before an apply", async () => {
    expect(sweepMismatch(await script([photo(u), own(u)]), "dry-run", { id: u, photos: 2 })).toBe("account counts");
    expect(sweepMismatch(await script([photo(u), own(u), own(other)]), "dry-run", { id: u, photos: 1 })).toBe("account counts");
    expect(sweepMismatch(await script([own(other)]), "dry-run", { id: u, photos: 0 })).toBe("listed accounts");
    expect(sweepMismatch(await script([]), "dry-run", { id: u, photos: 1 })).toBe("account counts");
    const document = { kind: "document", user_id: other, submission_id: other, storage_path: `${other}/${u}/front.webp` };
    expect(sweepMismatch(await script([photo(u), own(u), document]), "dry-run", { id: u, photos: 1 })).toBe("documents");
    const reviewer = { kind: "skipped_reviewer", user_id: other, submission_id: null, storage_path: null };
    expect(sweepMismatch(await script([photo(u), own(u), reviewer]), "dry-run", { id: u, photos: 1 })).toBe("skipped reviewers");
  });
  it("checks the apply summary and an empty second dry run", async () => {
    const applied = await script([photo(u), own(u)], true);
    expect(sweepMismatch(applied, "apply", { id: u, photos: 1 })).toBeNull();
    expect(sweepCounts(applied).done).toEqual({ batches: 1, photoObjects: 1, documentObjects: 0, accounts: 1, rateLimitsPurged: 3 });
    expect(sweepMismatch(applied, "dry-run", { id: u, photos: 1 })).toBe("mode or project");
    expect(sweepMismatch(await script([]), "dry-run", null)).toBeNull();
  });
  it("reports a partial apply as not ok with its failed step", async () => {
    const failed = await script([photo(u), own(u)], true, true);
    expect(sweepMismatch(failed, "apply", { id: u, photos: 1 })).toBe("not ok");
    expect(sweepCounts(failed)).toMatchObject({ exit: 1, ok: false, failed: "storage:profile-photos", status: 500 });
  });
  it("treats output without a summary line as not ok", () => {
    expect(parseSweep(0, "mode: dry-run\nnot json").summary).toBeNull();
    expect(sweepMismatch(parseSweep(0, ""), "dry-run", null)).toBe("not ok");
  });
});
