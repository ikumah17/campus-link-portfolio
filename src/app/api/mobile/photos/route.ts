import { backendMode } from "@/lib/backend";
import { MOBILE_JSON_HEADERS, notAllowed } from "@/server/mobile-auth";
import { mobileUpload } from "@/server/mobile-photos";
import { uploadResponse } from "@/server/photo-route-core";

// MOBILE-API-001: the app's photo upload (docs/42 §2 #5), Bearer only. The same gates, limits and answers as
// POST /api/photos (FIX-002, FIX-004, SEC-015), in src/server/photo-route-core.ts.
export async function POST(request: Request) {
  if (backendMode() === "demo") return new Response(null, { status: 404, headers: MOBILE_JSON_HEADERS });
  return uploadResponse(await mobileUpload(request));
}

export const GET = notAllowed("POST");
export const PUT = notAllowed("POST");
export const PATCH = notAllowed("POST");
export const DELETE = notAllowed("POST");
export const OPTIONS = notAllowed("POST");
