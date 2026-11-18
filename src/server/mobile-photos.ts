import "server-only";
import { backendMode } from "@/lib/backend";
import { bearerSession, bearerToken, type BearerRefusal } from "@/server/mobile-auth";
import {
  deliverAuthorizedPhoto, receivePhotoUpload, removeOwnPhoto, type RemovePhotoStatus, type UploadAnswer,
} from "@/server/photo-route-core";
import { accountFor, isUuid, type UploadSession } from "@/server/photo-upload";

// MOBILE-API-001: the app's photo upload, delivery and removal. REFACTOR-001: the steps after the session are the
// web's own, in src/server/photo-route-core.ts (POST /api/photos, GET /media/photos/[photoId] and the removePhoto
// action call the same functions); only the session comes from the Bearer token instead of the cookie. The web's
// same-origin check has no counterpart: no cookie is read (docs/42 §2.1).

// FIX-002: the Bearer check and my_account run before any body byte; the user id must be the same in both.
async function uploadAccount(request: Request): Promise<UploadSession | BearerRefusal> {
  const session = await bearerSession(request);
  if (session.status !== "ok") return session;
  try {
    const account = await accountFor(session.client);
    if (account.status !== "ok") return account;
    if (account.userId !== session.userId) return { status: "unavailable" };
    return { status: "ok", client: session.client, userId: account.userId };
  } catch {
    return { status: "unavailable" };
  }
}

// A request without a Bearer token is refused first, where the web route refuses a cross-origin one.
export async function mobileUpload(request: Request): Promise<UploadAnswer> {
  if (!bearerToken(request)) return { status: "unauthenticated" };
  return receivePhotoUpload(request, () => uploadAccount(request));
}

// The web delivery's checks. Every refusal is the same null, so the route answers the same 404; a missing or
// unusable token is "unauthenticated" instead.
export async function mobileDeliver(request: Request, photoId: unknown): Promise<ArrayBuffer | null | "unauthenticated"> {
  if (backendMode() === "demo") return null;
  if (!bearerToken(request)) return "unauthenticated";
  if (!isUuid(photoId)) return null;
  const session = await bearerSession(request);
  if (session.status === "unauthenticated") return "unauthenticated";
  if (session.status !== "ok") return null;
  return deliverAuthorizedPhoto(session.client, session.userId, photoId);
}

// The removePhoto action's steps; my_account must name the Bearer token's user.
export async function mobileRemove(request: Request, photoId: unknown): Promise<RemovePhotoStatus> {
  if (backendMode() === "demo") return "unavailable";
  if (!bearerToken(request)) return "unauthenticated";
  if (!isUuid(photoId)) return "invalid";
  const session = await bearerSession(request);
  if (session.status !== "ok") return session.status;
  return removeOwnPhoto(session.client, photoId, session.userId);
}
