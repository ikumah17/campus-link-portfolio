// Client-side demonstration of the server contract, never authorization.
// Fixed fictional identities and a fixed demo decision time keep transitions pure.
export type VerificationKind = "age" | "enrollment";
export type VerificationStatus = "submitted" | "in_review" | "approved" | "rejected" | "withdrawn";
export type Submission = {
  id: string; subjectId: string; kind: VerificationKind; refs: string[];
  status: VerificationStatus; version: number; reviewerId: string | null;
  displayName: string; birthDate: string; affiliation: string;
  decidedAt: string | null; reason: string | null;
};
export type VerificationState = readonly Submission[];
export type Result = { code: "ok" | "validation" | "invalid_state" | "not_available"; state: VerificationState };
export const kindLabels = { age: "年齢確認", enrollment: "在学確認" };
export const statusLabels = { submitted: "提出済み", in_review: "審査中", approved: "承認", rejected: "却下", withdrawn: "取り下げ" };
export const sampleRefs = ["synthetic:sample-1", "synthetic:sample-2", "synthetic:sample-3"];
export const sampleLabel = (ref: string) => `架空のサンプル資料${sampleRefs.indexOf(ref) + 1}`;
export const demoSubject = { subjectId: "demo-user", displayName: "デモ利用者（架空）", birthDate: "2000-02-29", affiliation: "デモ学校A（架空） / デモ学科A1（架空） / デモクラスA1-1（架空）" };
const decisionTime = "2026-10-30T00:00:00.000Z";
export function submit(state: VerificationState, kind: unknown, refs: readonly string[]): Result {
  if ((kind !== "age" && kind !== "enrollment") || refs.length < 1 || refs.length > 3 || new Set(refs).size !== refs.length || refs.some((ref) => !/^synthetic:sample-[1-3]$/.test(ref))) return { code: "validation", state };
  if (state.some((s) => s.subjectId === demoSubject.subjectId && s.kind === kind && (s.status === "submitted" || s.status === "in_review"))) return { code: "invalid_state", state };
  return { code: "ok", state: [...state, { ...demoSubject, id: `demo-submission-${state.length + 1}`, kind, refs: [...refs], status: "submitted", version: 1, reviewerId: null, decidedAt: null, reason: null }] };
}
function change(state: VerificationState, id: string, transition: (s: Submission) => Partial<Submission> | Result["code"]): Result {
  const current = state.find((s) => s.id === id);
  if (!current) return { code: "not_available", state };
  const patch = transition(current);
  if (typeof patch === "string") return { code: patch, state };
  return { code: "ok", state: state.map((s) => s.id === id ? { ...s, ...patch, version: s.version + 1 } : s) };
}
export function withdraw(state: VerificationState, id: string): Result {
  return change(state, id, (s) => s.subjectId !== demoSubject.subjectId ? "not_available" : s.status !== "submitted" ? "invalid_state" : { status: "withdrawn", decidedAt: decisionTime });
}
export function claim(state: VerificationState, id: string, reviewer: string): Result {
  return change(state, id, (s) => s.status !== "submitted" || !reviewer || s.subjectId === reviewer ? "invalid_state" : { status: "in_review", reviewerId: reviewer });
}
export function release(state: VerificationState, id: string, reviewer: string): Result {
  return change(state, id, (s) => s.status !== "in_review" || !reviewer || s.reviewerId !== reviewer ? "invalid_state" : { status: "submitted", reviewerId: null });
}
export function decide(state: VerificationState, id: string, reviewer: string, approve: boolean, reason: string, expectedVersion: number): Result {
  return change(state, id, (s) => {
    if (s.status !== "in_review" || !reviewer || s.reviewerId !== reviewer || s.version !== expectedVersion) return "invalid_state";
    if (!approve && ([...reason.trim()].length < 1 || [...reason].length > 200)) return "validation";
    return { status: approve ? "approved" : "rejected", decidedAt: decisionTime, reason: approve ? null : reason };
  });
}
