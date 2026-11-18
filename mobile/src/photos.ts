import { File } from "expo-file-system";
import { ImageManipulator, SaveFormat, type ImageRef } from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";
import { callRpc, isUuid, type RpcClient } from "./rpc";
import { DOWNSCALE_MAX_EDGE, DOWNSCALE_QUALITY, MAX_PHOTO_BYTES, targetSize } from "./shared";

// MOBILE-002 (docs/42 §2 #5): the app's photos. Upload, delivery and removal go through MOBILE-API-001's
// /api/mobile/photos routes with the Bearer token only (no cookie); reordering is the reorder_photos RPC, as on the
// web. The server still decodes, re-encodes and strips every upload (FIX-004, 4 MiB); shrinking here saves bytes on
// the wire and drops the original's metadata, as UI-014 does in the browser.
export type UploadStatus = "ok" | "invalid" | "too_large" | "too_many" | "rate_limited" | "unauthenticated" | "unavailable";
export type RemoveStatus = "ok" | "invalid" | "last_photo" | "unauthenticated" | "unavailable";
export type ReorderStatus = "ok" | "invalid" | "unauthenticated" | "unavailable";
export type PreparedPhoto = { uri: string; name: string; type: string; size: number };
export type PickedPhoto = { uri: string };

export const UPLOAD_TIMEOUT_MS = 60_000;
export const REQUEST_TIMEOUT_MS = 15_000;
export const MAX_PHOTOS = 6;
const UPLOAD_FAILURES: readonly UploadStatus[] = ["invalid", "too_large", "too_many", "rate_limited", "unauthenticated", "unavailable"];
const REMOVE_ANSWERS: readonly RemoveStatus[] = ["ok", "invalid", "last_photo", "unauthenticated", "unavailable"];

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

async function readStatus(response: Response): Promise<unknown> {
  const type = response.headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith("application/json")) return undefined;
  const body: unknown = await response.json().catch(() => null);
  return body && typeof body === "object" && "status" in body ? body.status : undefined;
}

export function createPhotoApi(baseUrl: string, token: () => Promise<string | null>, fetcher: Fetch = fetch) {
  async function send(path: string, init: RequestInit, timeoutMs: number): Promise<Response | "unauthenticated" | null> {
    const accessToken = await token().catch(() => null);
    if (!accessToken) return "unauthenticated";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetcher(`${baseUrl}${path}`, {
        ...init,
        headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
        credentials: "omit",
        signal: controller.signal,
      });
    } catch (error) {
      // A network error or a timeout. Never log the request: it holds the token. In development only, the error's
      // name and message (no URL, header or body) help diagnose device-only failures.
      if (__DEV__) console.warn(`photo request failed: ${error instanceof Error ? `${error.name}: ${error.message}` : typeof error}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    /** POST /api/mobile/photos, the web's uploadStatus mapping (src/components/photo-manager.tsx). */
    async upload(photo: PreparedPhoto): Promise<UploadStatus> {
      if (photo.size > MAX_PHOTO_BYTES) return "too_large";
      const data = new FormData();
      // FIX-007: SDK 58's fetch (expo/fetch) sends a part only as a Blob or as an object with bytes()
      // (expo/src/winter/fetch/convertFormData.ts); React Native's { uri } part fails with "Unsupported FormDataPart
      // implementation". The prepared JPEG is read through expo-file-system's File. A File's own name is its cache
      // file's and append's file name applies only to a real Blob, so the part carries the neutral name itself, never
      // the user's file name. A read failure rejects inside fetch and maps to "unavailable".
      data.append("photo", { name: photo.name, type: photo.type, bytes: () => new File(photo.uri).bytes() } as unknown as Blob);
      const response = await send("/api/mobile/photos", { method: "POST", body: data }, UPLOAD_TIMEOUT_MS);
      if (response === "unauthenticated") return "unauthenticated";
      if (!response) return "unavailable";
      // FIX-004: Vercel answers an oversized body with its own plain-text 413 before the route runs.
      if (response.status === 413) return "too_large";
      const status = await readStatus(response);
      if (status === "ok" && response.ok) return "ok";
      return UPLOAD_FAILURES.find((failure) => failure === status) ?? "unavailable";
    },
    /** DELETE /api/mobile/photos/[id]: the web's removePhoto (remove_photo, then the stored object). */
    async remove(photoId: string): Promise<RemoveStatus> {
      if (!isUuid(photoId)) return "invalid";
      const response = await send(`/api/mobile/photos/${photoId}`, { method: "DELETE" }, REQUEST_TIMEOUT_MS);
      if (response === "unauthenticated") return "unauthenticated";
      if (!response) return "unavailable";
      const status = await readStatus(response);
      const answer = REMOVE_ANSWERS.find((candidate) => candidate === status) ?? "unavailable";
      return answer === "ok" && !response.ok ? "unavailable" : answer;
    },
    /** The current access token for GET /api/mobile/photos/[id], or null. */
    token: () => token().catch(() => null),
  };
}

export type PhotoApi = ReturnType<typeof createPhotoApi>;

/**
 * The expo-image source of one delivered photo. Delivery is authorized per request (Bearer only); the image is kept
 * in memory only (cachePolicy "memory" at the call site), never on disk, and the memory cache is cleared at sign-out.
 */
export function photoSource(baseUrl: string, photoId: string, accessToken: string) {
  return { uri: `${baseUrl}/api/mobile/photos/${photoId}`, headers: { Authorization: `Bearer ${accessToken}` } };
}

// src/server/photo-actions.ts reorderPhotos.
export async function reorderPhotos(client: RpcClient, ids: unknown): Promise<ReorderStatus> {
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_PHOTOS || !Array.from(ids).every(isUuid) || new Set(ids).size !== ids.length) return "invalid";
  try {
    const result = await callRpc(client, "reorder_photos", { p_ids: ids });
    return result.code === "ok" ? "ok" : result.code === "unauthenticated" ? "unauthenticated" : "unavailable";
  } catch {
    return "unavailable";
  }
}

/** One image from the photo library (the system picker needs no library permission), or null when cancelled. */
export async function pickPhoto(): Promise<PickedPhoto | null> {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"], allowsMultipleSelection: false, allowsEditing: false, exif: false, base64: false, quality: 1,
  });
  const asset = result.canceled ? undefined : result.assets?.[0];
  return asset?.uri ? { uri: asset.uri } : null;
}

/** The decoded size of a base64 string. */
export function base64Bytes(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return Math.floor((value.length * 3) / 4) - padding;
}

/** In development builds only: the class of an error, never its message, the image URI or a token. */
export function warnPhotoFailure(stage: string, error: unknown) {
  if (typeof __DEV__ !== "undefined" && __DEV__) console.warn(`photo ${stage} failed: ${error instanceof Error ? error.name : typeof error}`);
}

/**
 * Shrinks a picked image to fit 1600 × 1600 (never enlarging) and encodes it as JPEG at the web's quality, so HEIC
 * and other formats the server refuses become an upload it accepts. The new file has no EXIF or location data.
 * Returns null when the image cannot be decoded or encoded.
 *
 * FIX-006: JPEG on every platform. It is the one format UIKit encodes natively (UIImage.jpegData); WebP on iOS needs
 * the SDWebImageWebPCoder plugin, and the server re-encodes every upload to WebP anyway (FIX-004).
 */
export async function preparePhoto(photo: PickedPhoto): Promise<PreparedPhoto | null> {
  const refs: ImageRef[] = [];
  try {
    // Decoding is bounded first, so a large camera photo is never held in memory at full size.
    let image = await ImageManipulator.manipulate(photo.uri, { maxWidth: DOWNSCALE_MAX_EDGE, maxHeight: DOWNSCALE_MAX_EDGE }).renderAsync();
    refs.push(image);
    const size = targetSize(image.width, image.height);
    if (size.width !== image.width || size.height !== image.height) {
      image = await ImageManipulator.manipulate(image).resize(size).renderAsync();
      refs.push(image);
    }
    const result = await image.saveAsync({ format: SaveFormat.JPEG, compress: DOWNSCALE_QUALITY, base64: true });
    if (!result.uri || typeof result.base64 !== "string") {
      warnPhotoFailure("prepare", new TypeError("empty result"));
      return null;
    }
    return { uri: result.uri, name: "photo.jpg", type: "image/jpeg", size: base64Bytes(result.base64) };
  } catch (error) {
    warnPhotoFailure("prepare", error);
    return null;
  } finally {
    for (const ref of refs) ref.release?.();
  }
}
