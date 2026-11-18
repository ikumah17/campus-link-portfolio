import "server-only";
import { createClient } from "@supabase/supabase-js";
import { supabasePublicConfig } from "@/lib/supabase/config";
import { callRpc, type RpcResult } from "@/server/rpc";

const BUCKET = "profile-photos";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

class PhotoStorageUnavailable extends Error {
  constructor() {
    super("Photo storage unavailable");
  }
}

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

function serviceClient() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key || !isServiceKey(key)) throw new PhotoStorageUnavailable();
  return createClient(supabasePublicConfig().url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function photoPath(userId: string, photoId: string): string {
  if ([userId, photoId].some((id) => typeof id !== "string" || id.length !== 36 || !UUID.test(id))) {
    throw new PhotoStorageUnavailable();
  }
  return `${userId}/${photoId}.webp`;
}

export async function storePhoto(userId: string, photoId: string, webp: Buffer): Promise<string> {
  const path = photoPath(userId, photoId);
  const { error } = await serviceClient().storage.from(BUCKET).upload(path, webp, {
    contentType: "image/webp", upsert: false,
  });
  if (error) throw new PhotoStorageUnavailable();
  return path;
}

export async function registerPhoto(userId: string, path: string): Promise<RpcResult> {
  // Use the same checked outcome/error mapping as the user's RPCs.
  return callRpc(serviceClient(), "service_register_photo", { p_user: userId, p_path: path });
}

export async function deleteStoredPhoto(userId: string, photoId: string): Promise<void> {
  const path = photoPath(userId, photoId);
  const { error } = await serviceClient().storage.from(BUCKET).remove([path]);
  if (error) throw new PhotoStorageUnavailable();
}
