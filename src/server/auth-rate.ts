import "server-only";
import { isIP } from "node:net";
import { headers } from "next/headers";
import { createClient } from "@supabase/supabase-js";
import { supabasePublicConfig } from "@/lib/supabase/config";
import { callRpc } from "@/server/rpc";

// SEC-006: Supabase Auth counts the server's IP, so the app reserves each sign-in attempt per typed address first.
export type SignInReservation = "ok" | "rate_limited" | "unavailable";

function isServiceKey(key: string): boolean {
  if (key.trim() !== key) return false;
  if (/^sb_secret_[A-Za-z0-9_-]+$/.test(key)) return true;
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(key)) return false;
  try {
    return JSON.parse(Buffer.from(key.split(".")[1], "base64url").toString("utf8")).role === "service_role";
  } catch {
    return false;
  }
}

// SEC-008: the client IP is trusted only on Vercel, whose edge overwrites x-forwarded-for and sets x-real-ip to the
// same value (https://vercel.com/docs/headers/request-headers). Anywhere else those headers can be forged, so there is
// no IP and only the per-address limit applies; the same holds for a missing or unparseable header.
async function trustedClientIp(): Promise<string | null> {
  if (process.env.VERCEL !== "1") return null;
  try {
    const ip = (await headers()).get("x-real-ip");
    // Plain IPv4 or IPv6 text only: no zone id, port, mask or whitespace.
    if (!ip || ip.length > 45 || !/^[0-9A-Fa-f:.]+$/.test(ip) || isIP(ip) === 0) return null;
    return ip;
  } catch {
    return null;
  }
}

// The address and IP go only into the RPC arguments; the database derives the peppered keys. Never log either.
async function reserve(rpc: "service_reserve_signin" | "service_reserve_signup", email: string): Promise<SignInReservation> {
  try {
    const ip = await trustedClientIp();
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!key || !isServiceKey(key)) return "unavailable";
    const client = createClient(supabasePublicConfig().url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const result = await callRpc(client, rpc, { p_email: email, p_ip: ip });
    // An rpc_outcome, never rows: any other shape fails closed.
    if (result.code === "ok") return Array.isArray(result.data) ? "unavailable" : "ok";
    return result.code === "rate_limited" ? "rate_limited" : "unavailable";
  } catch {
    return "unavailable";
  }
}

export function reserveSignIn(email: string): Promise<SignInReservation> {
  return reserve("service_reserve_signin", email);
}

// SEC-012: each sign-up sends a confirmation email, so it is reserved per typed address and, on Vercel, per client IP.
export function reserveSignUp(email: string): Promise<SignInReservation> {
  return reserve("service_reserve_signup", email);
}
