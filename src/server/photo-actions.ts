"use server";

import "server-only";
import { backendMode } from "@/lib/backend";
import { createServerSupabase } from "@/lib/supabase/server";
import { removeOwnPhoto, type RemovePhotoStatus } from "@/server/photo-route-core";
import { isUuid } from "@/server/photo-upload";
import { callRpc } from "@/server/rpc";

// SEC-007: uploads go through POST /api/photos (src/server/photo-upload.ts), so no action here takes a large body.
export type RemovePhotoResult = { status: RemovePhotoStatus };
export type ReorderPhotosResult = { status: "ok" | "unauthenticated" | "invalid" | "unavailable" };

// The removal steps are shared with the app's DELETE /api/mobile/photos/[photoId] (src/server/photo-route-core.ts).
export async function removePhoto(photoId: unknown): Promise<RemovePhotoResult> {
  if (backendMode() === "demo") return { status: "unavailable" };
  if (!isUuid(photoId)) return { status: "invalid" };
  try {
    return { status: await removeOwnPhoto(await createServerSupabase(), photoId) };
  } catch {
    return { status: "unavailable" };
  }
}

export async function reorderPhotos(ids: unknown): Promise<ReorderPhotosResult> {
  if (backendMode() === "demo") return { status: "unavailable" };
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 6 ||
      !Array.from(ids).every(isUuid) || new Set(ids).size !== ids.length) return { status: "invalid" };
  try {
    const result = await callRpc(await createServerSupabase(), "reorder_photos", { p_ids: ids });
    return { status: result.code === "ok" ? "ok" : result.code === "unauthenticated" ? "unauthenticated" : "unavailable" };
  } catch {
    return { status: "unavailable" };
  }
}
