"use server";

import "server-only";
import { redirect } from "next/navigation";
import { backendMode } from "@/lib/backend";
import { createServerSupabase } from "@/lib/supabase/server";
import type { AuthFormState } from "@/lib/auth-validation";
import { safeNextPath } from "@/lib/safe-next";
import { signInWithPassword, signUpWithPassword } from "@/server/auth-core";

// MOBILE-API-001: the checks live in src/server/auth-core.ts, shared with POST /api/mobile/auth/*; these actions add
// the cookie session and, after a sign-in, the redirect.
export async function signUpAction(_prev: AuthFormState, formData: FormData): Promise<AuthFormState> {
  return signUpWithPassword(formData.get("email"), formData.get("password"), createServerSupabase);
}

export async function signInAction(_prev: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const result = await signInWithPassword(formData.get("email"), formData.get("password"), createServerSupabase);
  if (result.status !== "signed_in") return result;
  redirect(safeNextPath(formData.get("next")) ?? "/");
}

async function signOutAndLeave(scope: "local" | "global", destination: string): Promise<AuthFormState> {
  if (backendMode() === "demo") return { status: "unavailable" };
  let failed = false;
  try {
    const client = await createServerSupabase();
    // auth-js answers { error } without throwing when the revoke fails, and still clears this device's session.
    const { error } = await client.auth.signOut({ scope });
    failed = !!error;
  } catch {
    // Signout still leaves the protected page after a transport failure.
    failed = true;
  }
  // FIX-002: a global sign-out that may have left other sessions valid says so on /login instead of /welcome.
  // The provider error is never shown or logged.
  redirect(scope === "global" && failed ? "/login?error=signout" : destination);
}

export async function signOutAction(): Promise<AuthFormState> {
  return signOutAndLeave("local", "/welcome");
}

// Ends the sessions on every device, not only this one (SEC-005 L-5).
export async function signOutEverywhereAction(): Promise<AuthFormState> {
  return signOutAndLeave("global", "/welcome");
}

// /auth/confirmed: someone who opened another person's confirmation link leaves that account on this device only.
export async function declineConfirmedAction(): Promise<AuthFormState> {
  return signOutAndLeave("local", "/login");
}
