import { backendMode } from "@/lib/backend";
import { signUpWithPassword } from "@/server/auth-core";
import { memoryClient, MOBILE_JSON_HEADERS, notAllowed } from "@/server/mobile-auth";
import { credentialsAnswer, readCredentials } from "@/server/mobile-credentials";

// MOBILE-API-001: the app's sign-up (docs/42 §2 #1). The web action's checks (src/server/auth-core.ts): the signup
// and, on Vercel, signup_ip reservations, the same emailRedirectTo, and the same "sent" for an existing address.
export async function POST(request: Request) {
  if (backendMode() === "demo") return new Response(null, { status: 404, headers: MOBILE_JSON_HEADERS });
  const credentials = await readCredentials(request);
  if (credentials instanceof Response) return credentials;
  return credentialsAnswer(await signUpWithPassword(credentials.email, credentials.password, async () => memoryClient()));
}

export const GET = notAllowed("POST");
export const PUT = notAllowed("POST");
export const PATCH = notAllowed("POST");
export const DELETE = notAllowed("POST");
export const OPTIONS = notAllowed("POST");
