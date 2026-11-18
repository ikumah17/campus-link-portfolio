import "server-only";
import { callerAccount } from "@/server/admin-gate";
import {
  accountFor, MAX_PHOTO_BYTES, photoBodySlots, photoUploadCooldowns, photoUploadLocks, uploadPhoto, type UploadPhotoStatus,
  type UploadSession,
} from "@/server/photo-upload";
import { boundedBody, declaredLength, mediaType, NO_STORE_HEADERS } from "@/server/request-body";
import { callRpc, type RpcClient } from "@/server/rpc";
import { deleteStoredPhoto } from "@/server/storage/photo-ingest";
import { readPhoto } from "@/server/storage/photo-read";

// REFACTOR-001: the photo upload, delivery and removal steps shared by the web (cookie session: POST /api/photos,
// GET /media/photos/[photoId], the removePhoto action) and the app (Bearer token: /api/mobile/photos/**). Each caller
// obtains the session and runs its own pre-session checks; everything after that is here, once.
// The body may be the 4 MiB photo plus 64 KiB for the multipart boundaries, part headers and file name (FIX-004:
// about 4.06 MiB, under Vercel's ~4.5 MB request body limit).
export const MAX_UPLOAD_BODY_BYTES = MAX_PHOTO_BYTES + 64 * 1024;
// A body not complete within this time is cancelled, so a slow sender cannot hold a body slot.
export const BODY_READ_MS = 30_000;
// FIX-009: every BODY_PROGRESS_WINDOW_MS the body must grow by BODY_PROGRESS_MIN_BYTES, or the read ends and the slot is
// freed: a sender that stops is cut within two windows (10 s), one that trickles within one. 64 KiB per 5 s is
// 12.8 KiB/s (about 105 kbit/s). The largest body already needs about 139 KiB/s on average to beat the 30-second cap,
// so this asks for less than a tenth of that: a slow phone line, even one that stalls for a few seconds, still passes,
// and so does a small photo on a line too slow for the largest one. The client shrinks an 8 MiB phone original before
// sending it (UI-014), and a body over MAX_UPLOAD_BODY_BYTES is refused by its Content-Length before any read.
export const BODY_PROGRESS_WINDOW_MS = 5_000;
export const BODY_PROGRESS_MIN_BYTES = 64 * 1024;
const BODY_PROGRESS = { windowMs: BODY_PROGRESS_WINDOW_MS, minBytes: BODY_PROGRESS_MIN_BYTES };
export const UPLOAD_HTTP_STATUS: Record<UploadPhotoStatus, number> = {
  ok: 200, invalid: 400, unauthenticated: 401, too_large: 413, too_many: 409, rate_limited: 429, unavailable: 503,
};
export type UploadAnswer = { status: UploadPhotoStatus; http?: number };
export const uploadResponse = ({ status, http }: UploadAnswer) =>
  Response.json({ status }, { status: http ?? UPLOAD_HTTP_STATUS[status], headers: NO_STORE_HEADERS });

// FIX-002: no body byte is read before the account check, this user's upload lock and a body slot have all passed;
// a refusal answers at once and spends no reservation. The lock and the slots are per process, so they do not bound
// memory across server instances; the web and the app share them, so a user uploading from both at once still holds
// one lock, and both paths share the four body slots.
// FIX-009: a user in the cooldown after a timed-out, slow or abandoned body is refused right after the account check,
// before the lock, the slot and the body; the progress deadline frees a slot taken by a slow sender early.
export async function receivePhotoUpload(
  request: Request,
  uploadAccount: () => Promise<UploadSession | { status: "unauthenticated" | "unavailable" }>,
): Promise<UploadAnswer> {
  const type = request.headers.get("content-type") ?? "";
  if (mediaType(request) !== "multipart/form-data") return { status: "invalid", http: 415 };
  const length = declaredLength(request, MAX_UPLOAD_BODY_BYTES);
  if (length === "length") return { status: "invalid", http: 411 };
  if (length === "too_large") return { status: "too_large" };
  const account = await uploadAccount();
  if (account.status !== "ok") return { status: account.status };
  if (photoUploadCooldowns.active(account.userId)) return { status: "rate_limited" };
  const unlock = photoUploadLocks.acquire(account.userId);
  if (!unlock) return { status: "rate_limited" };
  try {
    const releaseBody = await photoBodySlots.acquire();
    if (!releaseBody) return { status: "rate_limited" };
    let formData: FormData;
    try {
      const body = await boundedBody(request, MAX_UPLOAD_BODY_BYTES, BODY_READ_MS, BODY_PROGRESS);
      if (body === "too_large") return { status: "too_large" };
      if (body === "timeout" || body === "slow" || body === "aborted") {
        photoUploadCooldowns.start(account.userId);
        return { status: "invalid" };
      }
      formData = await new Response(body, { headers: { "Content-Type": type } }).formData();
    } catch {
      return { status: "invalid" };
    } finally {
      // The slot is freed as soon as the parsed FormData exists, or on any failure.
      releaseBody();
    }
    return { status: (await uploadPhoto(formData, account)).status };
  } finally {
    unlock();
  }
}

export const PHOTO_BROWSER_CACHE_SECONDS = 120;

/** The delivered image's headers; Vary names what carries the session. */
export function photoHeaders(vary: "Cookie" | "Authorization"): Record<string, string> {
  return {
    "Content-Type": "image/webp",
    "Cache-Control": `private, max-age=${PHOTO_BROWSER_CACHE_SECONDS}`,
    Vary: vary,
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Resource-Policy": "same-origin",
  };
}

// The delivery checks for a signed-in user and a well-formed photo id: per-request authorization of exactly this
// photo, the E-3 read, and an own photo refused once the account is deleted. Every refusal is the same null;
// "unauthenticated" is the database refusing the session, which the web answers like any other refusal.
export async function deliverAuthorizedPhoto(
  client: Parameters<typeof callerAccount>[0], userId: string, photoId: string,
): Promise<ArrayBuffer | null | "unauthenticated"> {
  try {
    const authorized = await callRpc(client, "authorize_photo_delivery", { p_photo_ids: [photoId] });
    if (authorized.code === "unauthenticated") return "unauthenticated";
    if (authorized.code !== "ok" || !Array.isArray(authorized.data) || authorized.data.length !== 1) return null;
    const row = authorized.data[0];
    if (!row || typeof row !== "object" || !("photo_id" in row) || row.photo_id !== photoId ||
        !("storage_path" in row) || typeof row.storage_path !== "string") return null;
    // Only an own photo can still be authorized for a deleted account where the database predates ACCOUNT-003
    // (order 17). The path starts with the owner's id, so only own photos pay for the extra account read.
    if (row.storage_path.split("/")[0] === userId && await callerAccount(client) !== "usable") return null;
    return await readPhoto({ photo_id: row.photo_id, storage_path: row.storage_path });
  } catch {
    return null;
  }
}

export type RemovePhotoStatus = "ok" | "unauthenticated" | "invalid" | "last_photo" | "unavailable";

// The removal steps for a well-formed photo id: my_account, remove_photo with the user's own session (the database
// checks ownership), then a best-effort removal of the stored object. A caller that already identified the user
// from its session passes that id, and my_account must name the same user.
export async function removeOwnPhoto(client: RpcClient, photoId: string, sessionUserId?: string): Promise<RemovePhotoStatus> {
  try {
    const account = await accountFor(client);
    if (account.status !== "ok") return account.status;
    if (sessionUserId !== undefined && account.userId !== sessionUserId) return "unavailable";
    const result = await callRpc(client, "remove_photo", { p_photo: photoId });
    if (result.code === "unauthenticated") return "unauthenticated";
    // SQL uses invalid_state for the last active photo of a completed profile
    // (and for a photo that is already inactive); not_available means no owned row.
    if (result.code === "invalid_state") return "last_photo";
    if (result.code !== "ok") return "unavailable";
    try { await deleteStoredPhoto(account.userId, photoId); } catch {
      // The row is already removed, so delivery is denied. Future maintenance
      // may need to remove an orphan object if this best-effort deletion failed.
    }
    return "ok";
  } catch {
    return "unavailable";
  }
}
