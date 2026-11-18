"use server";
import "server-only";
import { revalidatePath } from "next/cache";
import { backendMode } from "@/lib/backend";
import { createServerSupabase } from "@/lib/supabase/server";
import { UUID } from "@/server/discover-data";
import { callRpc } from "@/server/rpc";
// like_user / unlike_user (order 34, docs/43 §2.5, §2.6). A match answers ok with the new conversation's id.
export type LikeStatus = "ok" | "validation" | "not_available" | "already_connected" | "rate_limited" | "unauthenticated" | "unavailable";
type Result = { status: LikeStatus; conversationId?: string };
const known: LikeStatus[] = ["ok", "validation", "not_available", "already_connected", "rate_limited", "unauthenticated"];
async function perform(name: "like_user" | "unlike_user", target: unknown): Promise<Result> {
  try {
    if (backendMode() === "demo") return { status: "unavailable" };
    if (typeof target !== "string" || target.length !== 36 || !UUID.test(target)) return { status: "validation" };
    const result = await callRpc(await createServerSupabase(), name, { p_target: target });
    if (result.code !== "ok") return { status: known.includes(result.code as LikeStatus) ? result.code as LikeStatus : "unavailable" };
    for (const path of ["/", "/likes", "/talk"]) revalidatePath(path);
    const ref = !Array.isArray(result.data) ? result.data.ref : null;
    if (ref !== null && (ref.length !== 36 || !UUID.test(ref))) return { status: "unavailable" };
    return ref ? { status: "ok", conversationId: ref } : { status: "ok" };
  } catch { return { status: "unavailable" }; }
}
export async function likeUser(target: unknown): Promise<Result> { return perform("like_user", target); }
export async function unlikeUser(target: unknown): Promise<Result> { return perform("unlike_user", target); }
