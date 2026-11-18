import { execFile } from "node:child_process";
import { ownedUser } from "./lifecycle";
import { environment, readState } from "./state";

// HOSTED-RET-001. The sweep reads the server key from .env.local itself; this helper never passes,
// prints or keeps it. Evidence keeps counts only: no ids, paths, names or emails.
export const projectRef = "exampleprojectrefabc";
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export type Sweep = { exit: number; summary: Record<string, unknown> | null; users: string[]; submissions: number; skipped: number };
export function parseSweep(exit: number, stdout: string): Sweep {
  const lines = stdout.split(/\r?\n/).filter(Boolean);
  let summary: Record<string, unknown> | null = null;
  try {
    const last = JSON.parse(lines.at(-1) ?? "null");
    if (last && typeof last === "object" && !Array.isArray(last)) summary = last;
  } catch { /* no summary line */ }
  const ids = (pattern: RegExp) => lines.map(line => pattern.exec(line)?.[1]).filter((id): id is string => !!id && uuid.test(id));
  return { exit, summary, users: ids(/^ {2}user (\S+)$/), submissions: ids(/^ {2}submission (\S+)$/).length,
    skipped: ids(/^skipped reviewer (\S+)$/).length };
}

/** Runs scripts/maintenance/retention.mjs once: a dry run, or --apply --confirm for the dev project only. */
export async function sweep(apply: boolean): Promise<Sweep> {
  environment(); // refuses anything but the authorized dev project before the script runs
  const env = { ...process.env };
  // The script prefers these over .env.local; drop them so it reads the project the check above accepted.
  delete env.NEXT_PUBLIC_SUPABASE_URL;
  delete env.SUPABASE_SERVICE_ROLE_KEY;
  const args = ["scripts/maintenance/retention.mjs", ...(apply ? ["--apply", "--confirm", projectRef] : [])];
  return new Promise(resolve => {
    execFile(process.execPath, args, { env, timeout: 180_000, maxBuffer: 4_000_000, windowsHide: true }, (error, stdout) => {
      const code = error ? typeof error.code === "number" ? error.code : -1 : 0;
      resolve(parseSweep(code, String(stdout)));
    });
  });
}

/** Counts only, for evidence. */
export function sweepCounts(value: Sweep) {
  const s = value.summary ?? {};
  return { exit: value.exit, ok: s.ok ?? null, mode: s.mode ?? null, project: s.project ?? null, truncated: s.truncated ?? null,
    accounts: s.accounts ?? null, documents: s.documents ?? null, skippedReviewers: s.skipped_reviewers ?? null,
    done: s.done ?? null, failed: s.failed ?? null, status: s.status ?? null, listedUsers: value.users.length };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** The first mismatch against exactly one expected account (or none), as a finite label; null when it matches. */
export function sweepMismatch(value: Sweep, mode: "dry-run" | "apply", account: { id: string; photos: number } | null): string | null {
  const s = value.summary;
  if (value.exit !== 0 || !s || s.ok !== true) return "not ok";
  if (s.mode !== mode || s.project !== projectRef) return "mode or project";
  if (s.truncated !== false) return "truncated";
  if (!same(s.documents, { submissions: 0, objects: 0 }) || value.submissions !== 0) return "documents";
  if (s.skipped_reviewers !== 0 || value.skipped !== 0) return "skipped reviewers";
  if (!same(s.accounts, { users: account ? 1 : 0, objects: account?.photos ?? 0 })) return "account counts";
  if (!same(value.users, account ? [account.id] : [])) return "listed accounts";
  if (mode === "dry-run") return s.done === null ? null : "done";
  const done = s.done as Record<string, unknown> | null;
  if (!done || !Number.isInteger(done.rateLimitsPurged) || (done.rateLimitsPurged as number) < 0) return "rate limits";
  return same({ ...done, rateLimitsPurged: 0 }, { batches: 1, photoObjects: account?.photos ?? 0, documentObjects: 0,
    accounts: account ? 1 : 0, rateLimitsPurged: 0 }) ? null : "done";
}

// A ledger user's own session through the app's public RPCs, with the publishable key and that user's JWT only.
// Provider bodies and tokens never leave this boundary.
const ownRpcs = new Set(["request_account_deletion", "my_account"]);
async function publicPost(path: string, body: unknown, jwt?: string) {
  const env = environment();
  const key = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!key) throw new Error("Missing hosted public credential");
  try {
    const response = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}${path}`, {
      method: "POST", headers: { apikey: key, ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}), "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(30_000),
    });
    return { status: response.status, body: await response.json().catch(() => null) as unknown };
  } catch { throw new Error("Hosted own-account transport failed (details suppressed)"); }
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export async function ownSession(index: number) {
  const user = ownedUser(readState(), index);
  if (!user.password) throw new Error("Own-account session needs the run password");
  const login = await publicPost("/auth/v1/token?grant_type=password", { email: user.email, password: user.password });
  const data = record(login.body);
  const identity = record(data.user);
  const jwt = data.access_token;
  if (login.status !== 200 || identity.id !== user.id || identity.email !== user.email || typeof jwt !== "string") {
    throw new Error("Hosted own-account sign-in failed (details suppressed)");
  }
  return {
    async rpc(name: string) {
      if (!ownRpcs.has(name)) throw new Error("RPC outside own-account allowlist");
      const value = await publicPost(`/rest/v1/rpc/${name}`, {}, jwt);
      const row = record(value.body);
      const code = typeof row.code === "string" && /^(?:ok|invalid_state|[A-Z0-9]{5})$/.test(row.code) ? row.code : null;
      return { status: value.status, ok: row.ok === true, code, rows: Array.isArray(value.body) ? value.body.map(record) : [] };
    },
    async accountStatus() {
      const value = await this.rpc("my_account");
      const rows = value.rows.filter(row => row.user_id === user.id);
      return value.status === 200 && rows.length === 1 && typeof rows[0].account_status === "string" ? rows[0].account_status : null;
    },
  };
}
