import "server-only";
import { randomUUID } from "node:crypto";
import { backendMode } from "@/lib/backend";
import { createServerSupabase } from "@/lib/supabase/server";
import { MAX_PHOTO_BYTES } from "@/lib/photo-downscale";
import { createDecodeSlots, photoDecodeSlots, type Release } from "@/server/decode-slots";
import { callRpc, type RpcClient } from "@/server/rpc";
import { reencodePhoto } from "@/server/storage/photo-image";
import { deleteStoredPhoto, registerPhoto, storePhoto } from "@/server/storage/photo-ingest";

// SEC-007: the upload logic shared by POST /api/photos and its tests. Not a Server Action, so no Server Action
// needs a body larger than Next's default limit.
// FIX-004: the client and the server share one 4 MiB limit from @/lib/photo-downscale.
export { MAX_PHOTO_BYTES };
type Account = { status: "ok"; userId: string } | { status: "unauthenticated" | "unavailable" };
export type UploadSession = { status: "ok"; client: RpcClient; userId: string };
export type UploadPhotoStatus = "ok" | "unauthenticated" | "invalid" | "too_large" | "too_many" | "rate_limited" | "unavailable";
export type UploadPhotoResult = { status: "ok"; photoId: string } | { status: Exclude<UploadPhotoStatus, "ok"> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function isUuid(value: unknown): value is string {
  return typeof value === "string" && value.length === 36 && UUID.test(value);
}

export async function accountFor(client: RpcClient): Promise<Account> {
  const result = await callRpc(client, "my_account");
  if (result.code === "unauthenticated") return { status: "unauthenticated" };
  if (result.code !== "ok" || !Array.isArray(result.data) || result.data.length !== 1) return { status: "unavailable" };
  const row = result.data[0];
  if (!row || typeof row !== "object" || !("user_id" in row) || !isUuid(row.user_id)) return { status: "unavailable" };
  return { status: "ok", userId: row.user_id };
}

// FIX-002: POST /api/photos checks the account before it reads any body byte, then passes the session here.
export async function uploadAccount(): Promise<UploadSession | { status: "unauthenticated" | "unavailable" }> {
  try {
    const client = await createServerSupabase();
    const account = await accountFor(client);
    return account.status === "ok" ? { status: "ok", client, userId: account.userId } : account;
  } catch {
    return { status: "unavailable" };
  }
}

// FIX-002: before POST /api/photos reads a body, the user must hold the only upload lock for their id, and the
// request one of MAX_BODY_READS body slots (no queue). In-memory and per process, like the decode slots: they do not
// bound body memory across server instances.
export const MAX_BODY_READS = 4;
export const photoBodySlots = createDecodeSlots({ maxActive: MAX_BODY_READS, maxWaiting: 0 });
export type UploadLocks = { acquire(userId: string): Release | null; held(): number };
export function createUploadLocks(): UploadLocks {
  const holders = new Set<string>();
  return {
    acquire(userId) {
      if (holders.has(userId)) return null;
      holders.add(userId);
      // Each release runs once, so a later upload's lock is never freed by an earlier request.
      let done = false;
      return () => {
        if (done) return;
        done = true;
        holders.delete(userId);
      };
    },
    held: () => holders.size,
  };
}
export const photoUploadLocks = createUploadLocks();

// FIX-009: a user whose body timed out, came too slowly or was abandoned is refused for UPLOAD_COOLDOWN_MS before any
// body byte is read, so a slow sender cannot take a body slot again at once. In-memory and per process, like the lock.
// At most MAX_COOLDOWN_ENTRIES are kept: expired entries go first, then the oldest, which only shortens that user's
// wait. Every entry lasts equally long, so insertion order is expiry order.
export const UPLOAD_COOLDOWN_MS = 60_000;
export const MAX_COOLDOWN_ENTRIES = 10_000;
export type UploadCooldowns = { active(userId: string): boolean; start(userId: string): void; size(): number; clear(): void };
export function createUploadCooldowns({ ms = UPLOAD_COOLDOWN_MS, maxEntries = MAX_COOLDOWN_ENTRIES, now = () => Date.now() }:
  { ms?: number; maxEntries?: number; now?: () => number } = {}): UploadCooldowns {
  const until = new Map<string, number>();
  return {
    active(userId) {
      const end = until.get(userId);
      if (end === undefined) return false;
      if (now() < end) return true;
      until.delete(userId);
      return false;
    },
    start(userId) {
      const time = now();
      until.delete(userId);
      until.set(userId, time + ms);
      for (const [id, end] of until) {
        if (end > time && until.size <= maxEntries) break;
        until.delete(id);
      }
    },
    size: () => until.size,
    clear: () => until.clear(),
  };
}
export const photoUploadCooldowns = createUploadCooldowns();

export async function uploadPhoto(formData: FormData, session?: UploadSession): Promise<UploadPhotoResult> {
  if (backendMode() === "demo") return { status: "unavailable" };
  if (!(formData instanceof FormData)) return { status: "invalid" };
  const file = formData.get("photo");
  if (!(file instanceof File) || file.size === 0) return { status: "invalid" };
  if (file.size > MAX_PHOTO_BYTES) return { status: "too_large" };
  try {
    const account = session ?? await uploadAccount();
    if (account.status !== "ok") return { status: account.status };
    const { client } = account;
    // SEC-011: a decode slot first, so a busy server spends no reservation; it is freed when the decode ends.
    const release = await photoDecodeSlots.acquire();
    if (!release) return { status: "rate_limited" };
    let webp: Buffer;
    try {
      // SEC-004: one reservation per decode; anything but a well-formed ok means no decode.
      const reservation = await callRpc(client, "reserve_photo_upload");
      if (reservation.code === "unauthenticated") return { status: "unauthenticated" };
      if (reservation.code === "rate_limited") return { status: "rate_limited" };
      if (reservation.code !== "ok" || Array.isArray(reservation.data)) return { status: "unavailable" };
      try {
        webp = await reencodePhoto(Buffer.from(await file.arrayBuffer()));
      } catch {
        return { status: "invalid" };
      }
    } finally {
      release();
    }
    const photoId = randomUUID();
    const path = await storePhoto(account.userId, photoId, webp);
    let status: "too_many" | "unavailable" = "unavailable";
    try {
      const result = await registerPhoto(account.userId, path);
      if (result.code === "ok" && !Array.isArray(result.data) && result.data.ref === photoId) {
        return { status: "ok", photoId };
      }
      if (result.code === "invalid_state") status = "too_many";
    } catch {
      // Even an unexpected registration failure must attempt compensation.
    }
    try { await deleteStoredPhoto(account.userId, photoId); } catch {
      // Best effort: a failed compensation can leave an orphan for future maintenance.
    }
    return { status };
  } catch {
    return { status: "unavailable" };
  }
}
