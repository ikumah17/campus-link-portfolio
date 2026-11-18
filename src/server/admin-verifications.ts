import "server-only";
import { callRpc, type RpcClient } from "@/server/rpc";

export type SubmissionStatus = "submitted" | "in_review" | "approved" | "rejected" | "revoked";
export type SubmissionRow = {
  id: string; kind: "age" | "enrollment"; status: SubmissionStatus;
  assignedToMe: boolean; version: number; created_at: string;
};
type DetailBase = { id: string; status: "in_review"; version: number; created_at: string; documentCount: number };
export type SubmissionDetail = DetailBase & (
  { kind: "age"; birth_date: string | null } |
  { kind: "enrollment"; school_name: string | null; department_name: string | null; class_name: string | null }
);
type Failure = { status: "forbidden" | "unauthenticated" | "unavailable" };
const uuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
const timestamp = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v) && Number.isFinite(Date.parse(v));
const nullableText = (v: unknown): v is string | null => v === null || typeof v === "string";
const calendarDate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
const version = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
function record(v: unknown): v is Record<string, unknown> { return !!v && typeof v === "object" && !Array.isArray(v); }
function failure(code: string): Failure { return { status: code === "forbidden" || code === "unauthenticated" ? code : "unavailable" }; }

export async function listSubmissions(client: RpcClient, status: SubmissionStatus, me: string): Promise<{ status: "ok"; submissions: SubmissionRow[] } | Failure> {
  if (!uuid(me)) return { status: "unavailable" };
  const r = await callRpc(client, "admin_list_submissions", { p_status: status });
  if (r.code !== "ok") return failure(r.code);
  if (!Array.isArray(r.data)) return { status: "unavailable" };
  const submissions: SubmissionRow[] = [];
  for (const row of r.data) {
    if (!record(row) || !uuid(row.id) || !uuid(row.user_id) || (row.kind !== "age" && row.kind !== "enrollment") ||
      row.status !== status || !(row.reviewer_id === null || uuid(row.reviewer_id)) ||
      !(row.claimed_at === null || timestamp(row.claimed_at)) || !version(row.version) || !timestamp(row.created_at)) return { status: "unavailable" };
    submissions.push({ id: row.id, kind: row.kind, status, assignedToMe: row.reviewer_id === me, version: row.version, created_at: row.created_at });
  }
  return { status: "ok", submissions };
}

export async function getSubmission(client: RpcClient, id: string): Promise<{ status: "ok"; submission: SubmissionDetail | null } | Failure> {
  const r = await callRpc(client, "admin_get_submission", { p_id: id });
  if (r.code !== "ok") return failure(r.code);
  if (!Array.isArray(r.data) || r.data.length > 1) return { status: "unavailable" };
  if (r.data.length === 0) return { status: "ok", submission: null };
  const row: unknown = r.data[0];
  if (!record(row) || !uuid(row.id) || row.id !== id || !uuid(row.user_id) || row.status !== "in_review" || !version(row.version) ||
    (row.kind !== "age" && row.kind !== "enrollment") || !timestamp(row.created_at) ||
    !(row.birth_date === null || calendarDate(row.birth_date)) ||
    !nullableText(row.school_name) || !nullableText(row.department_name) || !nullableText(row.class_name) ||
    !Array.isArray(row.document_refs) || row.document_refs.length < 1 || row.document_refs.length > 4 ||
    !row.document_refs.every(v => typeof v === "string" && v.length > 0)) return { status: "unavailable" };
  const base: DetailBase = { id: row.id, status: "in_review", version: row.version, created_at: row.created_at, documentCount: row.document_refs.length };
  return { status: "ok", submission: row.kind === "age" ? { ...base, kind: "age", birth_date: row.birth_date } :
    { ...base, kind: "enrollment", school_name: row.school_name, department_name: row.department_name, class_name: row.class_name } };
}
