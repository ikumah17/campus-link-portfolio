import { backendMode } from "@/lib/backend";
import { signInWithPassword } from "@/server/auth-core";
import { memoryClient, MOBILE_JSON_HEADERS, notAllowed } from "@/server/mobile-auth";
import { credentialsAnswer, readCredentials, sessionAnswer } from "@/server/mobile-credentials";

// MOBILE-API-001: the app's sign-in (docs/42 §2 #2). The web action's checks (src/server/auth-core.ts): the signin
// and, on Vercel, signin_ip reservations, the 1500 ms failure floor and a deleted account's global sign-out answered
// as a wrong password. A pre-authentication request with no token; the session is returned in this JSON body only.
export async function POST(request: Request) {
  if (backendMode() === "demo") return new Response(null, { status: 404, headers: MOBILE_JSON_HEADERS });
  const credentials = await readCredentials(request);
  if (credentials instanceof Response) return credentials;
  const result = await signInWithPassword(credentials.email, credentials.password, async () => memoryClient());
  if (result.status !== "signed_in") return credentialsAnswer(result);
  return result.session ? sessionAnswer(result.session) : credentialsAnswer({ status: "unavailable" });
}

export const GET = notAllowed("POST");
export const PUT = notAllowed("POST");
export const PATCH = notAllowed("POST");
export const DELETE = notAllowed("POST");
export const OPTIONS = notAllowed("POST");
