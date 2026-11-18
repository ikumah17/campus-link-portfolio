import { MOBILE_JSON_HEADERS, notAllowed } from "@/server/mobile-auth";
import { mobileDeliver, mobileRemove } from "@/server/mobile-photos";
import { photoHeaders, type RemovePhotoStatus } from "@/server/photo-route-core";

// MOBILE-API-001: the app's photo delivery and removal (docs/42 §2 #5), Bearer only. Delivery answers the web's
// private 120-second cache with Vary: Authorization instead of Cookie (docs/42 §2.2); every refusal but a missing or
// unusable token is the same 404.
export const dynamic = "force-dynamic";
const REMOVE_HTTP: Record<RemovePhotoStatus, number> = { ok: 200, invalid: 400, unauthenticated: 401, last_photo: 409, unavailable: 503 };
const unauthenticated = () => Response.json({ status: "unauthenticated" }, { status: 401, headers: MOBILE_JSON_HEADERS });

export async function GET(request: Request, context: { params: Promise<{ photoId: string }> }) {
  let bytes: Awaited<ReturnType<typeof mobileDeliver>> = null;
  try {
    bytes = await mobileDeliver(request, (await context.params).photoId);
  } catch {
    // Refused below like any other failure.
  }
  if (bytes === "unauthenticated") return unauthenticated();
  if (bytes === null) return new Response(null, { status: 404, headers: MOBILE_JSON_HEADERS });
  return new Response(bytes, { headers: {
    ...photoHeaders("Authorization"),
    "Content-Security-Policy": MOBILE_JSON_HEADERS["Content-Security-Policy"],
  } });
}

export async function DELETE(request: Request, context: { params: Promise<{ photoId: string }> }) {
  let status: RemovePhotoStatus = "unavailable";
  try {
    status = await mobileRemove(request, (await context.params).photoId);
  } catch {
    // Answered as unavailable.
  }
  return Response.json({ status }, { status: REMOVE_HTTP[status], headers: MOBILE_JSON_HEADERS });
}

export const POST = notAllowed("GET, DELETE");
export const PUT = notAllowed("GET, DELETE");
export const PATCH = notAllowed("GET, DELETE");
export const OPTIONS = notAllowed("GET, DELETE");
