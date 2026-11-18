// RETENTION-001 retention sweep (docs/04_DATABASE.md §11; the periods are proposals, O4).
// Lists due data with public.service_retention_candidates and, only with --apply, deletes it in this order:
// Storage objects (profile-photos, with the orphan photos no row names, then verification-documents, with the
// orphan documents no submission names), then the expired accounts through the Auth Admin API (their rows cascade), then rate-limit records older than 7 days. A failure stops the run; a re-run
// continues from what is left. A listing cut at the server's row limit is detected from its exact count and
// worked through in batches. Reads the server key from the environment or .env.local and never prints it,
// nor any path, name or email.
//
//   node scripts/maintenance/retention.mjs                                # dry run
//   node scripts/maintenance/retention.mjs --apply --confirm <project-ref>
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PROJECT_URL = /^https:\/\/([a-z0-9]{20})\.supabase\.co$/;
const PHOTOS = "profile-photos";
const DOCUMENTS = "verification-documents";
const CHUNK = 100;
// p_now is taken this far before the local clock: service_retention_candidates refuses a p_now later than the
// database's now(), and this PC's clock was measured 0.7 to 1.0 s ahead of the server (FIX-003). The margin only
// ever lists less (data due within the last minute waits for the next run); a clock ahead by more still fails closed.
const CLOCK_MARGIN_MS = 60_000;

class Refusal extends Error {}

class StepFailed extends Error {
  constructor(step, status) {
    super(step);
    this.step = step;
    this.status = status;
  }
}

export function parseArgs(argv) {
  const args = { apply: false, confirm: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") args.apply = true;
    else if (arg === "--confirm" && i + 1 < argv.length) args.confirm = argv[(i += 1)];
    else if (arg.startsWith("--confirm=")) args.confirm = arg.slice("--confirm=".length);
    else throw new Refusal("unknown argument");
  }
  return args;
}

function readEnvFile(file) {
  if (!existsSync(file)) return {};
  return Object.fromEntries(readFileSync(file, "utf8").split(/\r?\n/)
    .filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
}

function isServiceKey(key) {
  if (typeof key !== "string" || key.trim() !== key) return false;
  if (/^sb_secret_[A-Za-z0-9_-]+$/.test(key)) return true;
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(key)) return false;
  try {
    return JSON.parse(Buffer.from(key.split(".")[1], "base64url").toString("utf8")).role === "service_role";
  } catch {
    return false;
  }
}

export function loadConfig(env, envFile) {
  const file = readEnvFile(envFile);
  const url = env.NEXT_PUBLIC_SUPABASE_URL || file.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY || file.SUPABASE_SERVICE_ROLE_KEY;
  const match = PROJECT_URL.exec(url ?? "");
  if (!match) throw new Refusal("unexpected project URL");
  if (!isServiceKey(key)) throw new Refusal("missing server key");
  return { url, key, ref: match[1] };
}

/** Rejects anything the rules could not have produced, so a bad row can never widen a deletion. */
function checkCandidates(rows) {
  if (!Array.isArray(rows)) throw new StepFailed("candidates", null);
  for (const r of rows) {
    const known = (r.kind === "skipped_reviewer" && r.submission_id === null && r.storage_path === null)
      || (r.kind === "document" && r.submission_id !== null && r.storage_path !== null)
      || (r.kind === "account" && (r.storage_path !== null || r.submission_id === null))
      || ((r.kind === "orphan_photo" || r.kind === "orphan_document") && r.submission_id === null && r.storage_path !== null);
    const ids = UUID.test(r.user_id ?? "") && (r.submission_id === null || UUID.test(r.submission_id));
    const path = r.storage_path === null || (typeof r.storage_path === "string"
      && r.storage_path.startsWith(`${r.user_id}/`)
      && /^[0-9a-f-]{36}(\/[A-Za-z0-9_-]{1,64})+\.webp$/.test(r.storage_path));
    if (!known || !ids || !path) throw new StepFailed("candidates", null);
  }
  return rows;
}

/**
 * A cut listing (truncated) is a prefix of the ordered candidates, and each account's own row comes after its
 * objects, so only the last account can be incomplete: it is left whole for the next batch.
 */
export function plan(rows, truncated = false) {
  // Validate the raw prefix before dropping an incomplete trailing account.
  const closed = new Set();
  let current = null;
  let ownSeen = false;
  let accountsEnded = false;
  for (const r of rows) {
    if (r.kind !== "account") accountsEnded = true;
    else if (accountsEnded) throw new StepFailed("candidates", null);
    if (r.kind !== "account" || r.user_id !== current) {
      if (current !== null) {
        if (!ownSeen) throw new StepFailed("candidates", null);
        closed.add(current);
      }
      current = null;
      ownSeen = false;
      if (r.kind === "account") {
        if (closed.has(r.user_id)) throw new StepFailed("candidates", null);
        current = r.user_id;
      }
    }
    if (r.kind === "account") {
      if (ownSeen) throw new StepFailed("candidates", null);
      ownSeen = r.storage_path === null;
    }
  }
  if (current !== null && !ownSeen && !truncated) throw new StepFailed("candidates", null);
  const last = rows.at(-1);
  if (truncated && last?.kind === "account" && last.storage_path !== null) {
    rows = rows.filter((r) => r.kind !== "account" || r.user_id !== last.user_id);
  }
  const objects = { [PHOTOS]: [], [DOCUMENTS]: [] };
  const submissions = new Set();
  const accounts = new Set();
  let documentObjects = 0;
  let accountObjects = 0;
  let orphanObjects = 0;
  let orphanDocuments = 0;
  for (const r of rows) {
    if (r.kind === "skipped_reviewer") continue;
    if (r.kind === "account" && r.storage_path === null) { accounts.add(r.user_id); continue; }
    if (r.kind === "orphan_photo") { objects[PHOTOS].push(r.storage_path); orphanObjects += 1; continue; }
    if (r.kind === "orphan_document") { objects[DOCUMENTS].push(r.storage_path); orphanDocuments += 1; continue; }
    // account rows: a photo has no submission; documents always belong to one
    const bucket = r.kind === "account" && r.submission_id === null ? PHOTOS : DOCUMENTS;
    objects[bucket].push(r.storage_path);
    if (r.kind === "document") { submissions.add(r.submission_id); documentObjects += 1; } else accountObjects += 1;
  }
  for (const r of rows) if (r.kind === "account" && !accounts.has(r.user_id)) throw new StepFailed("candidates", null);
  return {
    objects,
    submissions: [...submissions].sort(),
    accounts: [...accounts].sort(),
    counts: { documentObjects, accountObjects, orphanObjects, orphanDocuments },
  };
}

function client(config, fetchImpl) {
  const base = { apikey: config.key, Authorization: `Bearer ${config.key}`, "Content-Type": "application/json" };
  return async (step, method, path, body, extra = {}) => {
    let res;
    try {
      res = await fetchImpl(`${config.url}${path}`, { method, headers: { ...base, ...extra },
        body: body === undefined ? undefined : JSON.stringify(body) });
    } catch {
      throw new StepFailed(step, null);
    }
    if (!res.ok) throw new StepFailed(step, res.status);
    return { body: await res.json().catch(() => null), headers: res.headers };
  };
}

/** One candidate listing with the server's exact row count; a response with fewer rows was cut (db-max-rows). */
async function list(call, p_now) {
  const { body, headers } = await call("candidates", "POST", "/rest/v1/rpc/service_retention_candidates", { p_now },
    { Prefer: "count=exact" });
  const rows = checkCandidates(body);
  const range = /^(?:\d+-\d+|\*)\/(\d+)$/.exec(headers.get("content-range") ?? "");
  const total = range ? Number(range[1]) : NaN;
  if (!(total >= rows.length)) throw new StepFailed("candidates", null);
  return { rows, total, truncated: rows.length < total };
}

/** Runs the sweep. Returns the process exit code; every line goes through `log` (no key, path, name or email). */
export async function run({ argv = [], env = {}, envFile, fetch: fetchImpl = globalThis.fetch, log = console.log, now = Date.now } = {}) {
  // one value for every listing and the purge
  const p_now = new Date(now() - CLOCK_MARGIN_MS).toISOString();
  const skippedReviewers = new Set();
  const summary = { p_now, skipped_reviewers: 0, ok: false, mode: "dry-run", project: null, truncated: null, documents: null, accounts: null, orphans: null, orphan_documents: null, done: null };
  let args;
  let config;
  try {
    args = parseArgs(argv);
    summary.mode = args.apply ? "apply" : "dry-run";
    config = loadConfig(env, envFile);
    summary.project = config.ref;
    if (args.apply && args.confirm !== config.ref) throw new Refusal("--apply needs --confirm <project-ref> of this project");
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    log(`refused: ${error.message}`);
    log(JSON.stringify({ ...summary, refused: error.message }));
    return 2;
  }

  const call = client(config, fetchImpl);
  const done = { batches: 0, photoObjects: 0, documentObjects: 0, accounts: 0, rateLimitsPurged: null };
  const seen = { submissions: new Set(), accounts: new Set(), documentObjects: 0, accountObjects: 0, orphanObjects: 0, orphanDocuments: 0 };
  try {
    log(`mode: ${summary.mode} (project ${config.ref})`);
    let previous = Infinity;
    for (;;) {
      const listing = await list(call, p_now);
      // every applied batch deletes something, so the next listing must be shorter
      if (listing.total >= previous) throw new StepFailed("candidates", null);
      const work = plan(listing.rows, listing.truncated);
      for (const r of listing.rows) if (r.kind === "skipped_reviewer") {
        if (!skippedReviewers.has(r.user_id)) log(`skipped reviewer ${r.user_id}`);
        skippedReviewers.add(r.user_id);
      }
      summary.skipped_reviewers = skippedReviewers.size;
      summary.truncated ??= listing.truncated;
      for (const id of work.submissions) seen.submissions.add(id);
      for (const id of work.accounts) seen.accounts.add(id);
      seen.documentObjects += work.counts.documentObjects;
      seen.accountObjects += work.counts.accountObjects;
      seen.orphanObjects += work.counts.orphanObjects;
      seen.orphanDocuments += work.counts.orphanDocuments;
      summary.documents = { submissions: seen.submissions.size, objects: seen.documentObjects };
      summary.accounts = { users: seen.accounts.size, objects: seen.accountObjects };
      summary.orphans = { objects: seen.orphanObjects };
      summary.orphan_documents = { objects: seen.orphanDocuments };
      if (listing.truncated) log(`candidates: ${listing.rows.length} of ${listing.total} row(s) in this listing`);
      log(`document: ${work.counts.documentObjects} object(s) in ${work.submissions.length} submission(s)`);
      for (const id of work.submissions) log(`  submission ${id}`);
      log(`account: ${work.accounts.length} account(s), ${work.counts.accountObjects} object(s)`);
      for (const id of work.accounts) log(`  user ${id}`);
      // a count only: an orphan's path and folder (a user id) are never printed
      log(`orphan photo: ${work.counts.orphanObjects} object(s)`);
      log(`orphan document: ${work.counts.orphanDocuments} object(s)`);
      if (!args.apply) {
        if (listing.truncated) log("the rest is listed in later batches of an --apply run");
        log("rate limits: records older than 7 days are purged only with --apply");
        summary.ok = true;
        log(JSON.stringify(summary));
        return 0;
      }

      const empty = work.accounts.length === 0 && work.objects[PHOTOS].length === 0 && work.objects[DOCUMENTS].length === 0;
      if (listing.truncated && empty) throw new StepFailed("candidates", null);
      summary.done = done;
      done.batches += 1;
      for (const [bucket, counter] of [[PHOTOS, "photoObjects"], [DOCUMENTS, "documentObjects"]]) {
        const paths = work.objects[bucket];
        for (let i = 0; i < paths.length; i += CHUNK) {
          const prefixes = paths.slice(i, i + CHUNK);
          const { body: removed } = await call(`storage:${bucket}`, "DELETE", `/storage/v1/object/${bucket}`, { prefixes });
          if (!Array.isArray(removed) || prefixes.some((path) => !removed.some((object) => object?.name === path))) {
            throw new StepFailed(`storage:${bucket}`, null);
          }
          done[counter] += prefixes.length;
        }
      }
      for (const id of work.accounts) {
        await call("auth", "DELETE", `/auth/v1/admin/users/${id}`);
        done.accounts += 1;
      }
      if (!listing.truncated) break;
      previous = listing.total;
    }
    const { body: purged } = await call("rate-limits", "POST", "/rest/v1/rpc/service_purge_rate_limits", { p_now });
    if (!Number.isInteger(purged)) throw new StepFailed("rate-limits", null);
    done.rateLimitsPurged = purged;
    summary.ok = true;
    log(JSON.stringify(summary));
    return 0;
  } catch (caught) {
    // an unexpected error is reported only as "internal": its message could carry request details
    const error = caught instanceof StepFailed ? caught : new StepFailed("internal", null);
    log(`stopped at ${error.step}${error.status ? ` (HTTP ${error.status})` : ""}; nothing after it ran`);
    log(JSON.stringify({ ...summary, failed: error.step, status: error.status }));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await run({
    argv: process.argv.slice(2),
    env: process.env,
    envFile: new URL("../../.env.local", import.meta.url),
  });
}
