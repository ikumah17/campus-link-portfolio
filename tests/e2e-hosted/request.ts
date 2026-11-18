import type { APIRequestContext } from "@playwright/test";

// TEST-017: a failed APIRequestContext call throws Playwright's call log, which lists every request header, including
// the run user's sb- auth cookie (JWT and refresh token). Every hosted page.request/context.request call goes through
// appGet, which rethrows a fixed message instead: method, path without the query, and an error class. The original error
// is dropped (no cause, no message text), so nothing it carried can reach the reporter.
type GetOptions = Parameters<APIRequestContext["get"]>[1];

const CODES = ["ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "ETIMEDOUT", "EPIPE", "EHOSTUNREACH", "ENETUNREACH", "ENOTFOUND", "EAI_AGAIN"];
export function errorClass(error: unknown) {
  if (!(error instanceof Error)) return "unknown";
  const message = error.message;
  const code = CODES.find(code => message.includes(code));
  if (code) return code;
  if (error.name === "TimeoutError" || /timed out|Timeout \d+ms exceeded/i.test(message)) return "timeout";
  if (/socket hang up/i.test(message)) return "socket hang up";
  if (/has been closed/i.test(message)) return "closed";
  return "error";
}
export function requestPath(url: string) {
  try { return new URL(url, "http://127.0.0.1").pathname; } catch { return "(unparsed path)"; }
}
export class RequestFailed extends Error {
  constructor(readonly method: string, readonly path: string, readonly kind: string) {
    super(`${method} ${path} failed: ${kind}`);
    this.name = "RequestFailed";
  }
}
export function redacted(method: string, url: string, error: unknown) {
  return new RequestFailed(method, requestPath(url), errorClass(error));
}
export async function appGet(request: APIRequestContext, url: string, options?: GetOptions) {
  try { return await request.get(url, options); }
  catch (error) { throw redacted("GET", url, error); }
}
