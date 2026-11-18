"use server";
import "server-only";
import { backendMode } from "@/lib/backend";
import { createServerSupabase } from "@/lib/supabase/server";
import { callRpc } from "@/server/rpc";
export type VerificationResult = { status: "ok" | "invalid" | "invalid_state" | "unauthenticated" | "unavailable" };
export async function submitVerification(kind: unknown, refs: unknown): Promise<VerificationResult> {
  if (backendMode() === "demo") return { status: "unavailable" };
  if ((kind !== "age" && kind !== "enrollment") || !Array.isArray(refs) || refs.length < 1 || refs.length > 3 || new Set(refs).size !== refs.length || !Array.from(refs).every(r => typeof r === "string" && r.length === 18 && /^synthetic:sample-[1-3]$/.test(r))) return { status: "invalid" };
  try {
    const r = await callRpc(await createServerSupabase(), "submit_verification", { p_kind: kind, p_document_refs: refs });
    return { status: r.code === "validation" ? "invalid" : ["ok", "invalid_state", "unauthenticated"].includes(r.code) ? r.code as "ok" | "invalid_state" | "unauthenticated" : "unavailable" };
  } catch { return { status: "unavailable" }; }
}
export async function withdrawVerification(id: unknown): Promise<VerificationResult> {
  if (backendMode() === "demo") return { status: "unavailable" };
  if (typeof id !== "string" || id.length !== 36 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) return { status: "invalid" };
  try {
    const r = await callRpc(await createServerSupabase(), "withdraw_verification", { p_id: id });
    return { status: r.code === "not_available" ? "invalid_state" : r.code === "validation" ? "invalid" : ["ok", "invalid_state", "unauthenticated"].includes(r.code) ? r.code as "ok" | "invalid_state" | "unauthenticated" : "unavailable" };
  } catch { return { status: "unavailable" }; }
}
