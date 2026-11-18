"use server";

import "server-only";
import { backendMode } from "@/lib/backend";
import { createServerSupabase } from "@/lib/supabase/server";
import { callRpc } from "@/server/rpc";

type Failure = "invalid_code" | "rate_limited" | "unauthenticated" | "unavailable";
type Enrollment = { status: "enroll"; qrCode: string; secret: string } | { status: "already_enrolled" | "unauthenticated" | "unavailable" };

function errorStatus(error: { name?: string; code?: string; status?: number }): Failure {
  if (error.status === 429 || error.code === "over_request_rate_limit") return "rate_limited";
  if (error.code === "mfa_verification_failed" || error.code === "mfa_challenge_expired") return "invalid_code";
  if (error.name === "AuthSessionMissingError" || ["session_not_found", "session_expired", "refresh_token_not_found", "refresh_token_already_used"].includes(error.code ?? "") || error.status === 401) return "unauthenticated";
  return "unavailable";
}

export async function startTotpEnrollment(): Promise<Enrollment> {
  if (backendMode() === "demo") return { status: "unavailable" };
  try {
    const client = await createServerSupabase();
    const { data, error } = await client.auth.mfa.listFactors();
    if (error) return { status: errorStatus(error) === "unauthenticated" ? "unauthenticated" : "unavailable" };
    if (!data) return { status: "unavailable" };
    const factors = data.all.filter((factor) => factor.factor_type === "totp");
    if (factors.some((factor) => factor.status === "verified")) return { status: "already_enrolled" };
    for (const factor of factors.filter((factor) => factor.status === "unverified")) {
      const { error } = await client.auth.mfa.unenroll({ factorId: factor.id });
      if (error) return { status: errorStatus(error) === "unauthenticated" ? "unauthenticated" : "unavailable" };
    }
    const enrolled = await client.auth.mfa.enroll({ factorType: "totp" });
    if (enrolled.error) return { status: errorStatus(enrolled.error) === "unauthenticated" ? "unauthenticated" : "unavailable" };
    const totp = enrolled.data?.type === "totp" ? enrolled.data.totp : null;
    if (!totp || typeof totp.qr_code !== "string" || !totp.qr_code.startsWith("data:image/svg+xml") || typeof totp.secret !== "string" || !totp.secret.trim()) return { status: "unavailable" };
    return { status: "enroll", qrCode: totp.qr_code, secret: totp.secret };
  } catch {
    // The secret, code and provider errors never enter logs or persisted state.
    return { status: "unavailable" };
  }
}

export async function verifyTotp(code: unknown): Promise<{ status: "ok" | Failure }> {
  if (backendMode() === "demo") return { status: "unavailable" };
  if (typeof code !== "string" || !/^[0-9]{6}$/.test(code)) return { status: "invalid_code" };
  try {
    const client = await createServerSupabase();
    const { data, error } = await client.auth.mfa.listFactors();
    if (error) return { status: errorStatus(error) };
    if (!data) return { status: "unavailable" };
    // SDK 2.118: `totp` contains only verified factors; `all` also has pending ones.
    const factors = data.all.filter((factor) => factor.factor_type === "totp");
    const factor = factors.find((factor) => factor.status === "verified") ?? factors
      .filter((factor) => factor.status === "unverified")
      .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
    if (!factor) return { status: "unavailable" };
    // SEC-006: one attempt per code, counted per user before Auth sees it; any other answer fails closed.
    const reservation = await callRpc(client, "reserve_mfa_attempt");
    if (reservation.code !== "ok" || Array.isArray(reservation.data)) return { status: reservation.code === "rate_limited" ? "rate_limited" : "unavailable" };
    const result = await client.auth.mfa.challengeAndVerify({ factorId: factor.id, code });
    return { status: result.error ? errorStatus(result.error) : "ok" };
  } catch {
    return { status: "unavailable" };
  }
}
