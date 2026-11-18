"use server";
import "server-only";
import { backendMode } from "@/lib/backend";
import { createServerSupabase } from "@/lib/supabase/server";
import { REJECTION_REASONS, REVOCATION_REASONS } from "@/lib/verification-reasons";
import { callRpc } from "@/server/rpc";

export type AdminVerificationResult = { status: "ok" | "invalid" | "invalid_state" | "forbidden" | "unauthenticated" | "unavailable" };
const uuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
const kind = (v: unknown) => v === "age" || v === "enrollment";
function record(v: unknown): v is Record<string, unknown> { return !!v && typeof v === "object" && !Array.isArray(v); }
async function run(name: string, args: Record<string, unknown>): Promise<AdminVerificationResult> {
  try {
    const r = await callRpc(await createServerSupabase(), name, args);
    switch (r.code) {
      case "ok": case "invalid_state": case "forbidden": case "unauthenticated": return { status: r.code };
      case "not_available": return { status: "invalid_state" };
      case "validation": return { status: "invalid" };
      default: return { status: "unavailable" };
    }
  } catch { return { status: "unavailable" }; }
}
export async function claimSubmission(id: unknown): Promise<AdminVerificationResult> {
  if (backendMode() === "demo") return { status: "unavailable" };
  return uuid(id) ? run("admin_claim_submission", { p_id: id }) : { status: "invalid" };
}
export async function releaseSubmission(id: unknown): Promise<AdminVerificationResult> {
  if (backendMode() === "demo") return { status: "unavailable" };
  return uuid(id) ? run("admin_release_submission", { p_id: id }) : { status: "invalid" };
}
export async function decideSubmission(input: unknown): Promise<AdminVerificationResult> {
  if (backendMode() === "demo") return { status: "unavailable" };
  if (!record(input) || !uuid(input.id) || !kind(input.kind) || typeof input.approve !== "boolean" ||
    typeof input.expectedVersion !== "number" || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) return { status: "invalid" };
  let reason: string | null = null;
  let validUntil: string | null = null;
  if (!input.approve) {
    if (typeof input.reason !== "string" || !Object.hasOwn(REJECTION_REASONS, input.reason)) return { status: "invalid" };
    reason = input.reason;
  } else if (input.kind === "enrollment") {
    const date = input.validUntil;
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return { status: "invalid" };
    const parsed = new Date(`${date}T00:00:00Z`);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date || date <= today) return { status: "invalid" };
    validUntil = `${date}T23:59:59+09:00`;
  }
  return run("admin_decide_submission", { p_id: input.id, p_approve: input.approve, p_reason: reason, p_valid_until: validUntil, p_expected_version: input.expectedVersion });
}
export async function revokeVerification(input: unknown): Promise<AdminVerificationResult> {
  if (backendMode() === "demo") return { status: "unavailable" };
  if (!record(input) || !uuid(input.submissionId) || typeof input.reason !== "string" || !Object.hasOwn(REVOCATION_REASONS, input.reason)) return { status: "invalid" };
  return run("admin_revoke_verification", { p_submission: input.submissionId, p_reason: input.reason });
}
