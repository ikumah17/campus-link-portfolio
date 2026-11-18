import { describe, expect, it } from "vitest";
import type { APIRequestContext } from "@playwright/test";
import { appGet, RequestFailed } from "./request";

// TEST-017: the shape of Playwright's APIRequestContext failure, with its call log listing the sent cookie header.
// A fake, unsigned JWT built at run time, so no token-shaped literal sits in the source (the push guard refuses those).
const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = `${part({ alg: "HS256", typ: "JWT" })}.${part({ sub: "unit-user", role: "authenticated" })}.${Buffer.from("signature-unit").toString("base64url")}`;
const cookie = `sb-unitproject-auth-token=base64-${Buffer.from(JSON.stringify({ access_token: jwt, refresh_token: "unit-refresh-secret" })).toString("base64")}`;
const secrets = [jwt, "unit-refresh-secret", "refresh_token", "sb-unitproject-auth-token", "base64-", "eyJ", "cookie", "tab=sent"];
function playwrightError(kind: string, name = "Error") {
  const error = new Error(`apiRequestContext.get: ${kind}\nCall log:\n  - → GET http://127.0.0.1:3207/profiles/00000000-0000-4000-8000-000000000001?tab=sent\n` +
    `    - user-agent: Playwright\n    - cookie: ${cookie}\n    - authorization: Bearer ${jwt}\n    - refresh_token=unit-refresh-secret\n`);
  error.name = name;
  return error;
}
const failing = (error: unknown) => ({ get: () => Promise.reject(error) }) as unknown as APIRequestContext;
async function thrown(error: unknown) {
  try { await appGet(failing(error), "/profiles/00000000-0000-4000-8000-000000000001?tab=sent"); }
  catch (caught) { return caught; }
  throw new Error("appGet did not throw");
}
function everything(error: unknown) {
  const own = error instanceof Error ? Object.getOwnPropertyNames(error).map(key => String((error as unknown as Record<string, unknown>)[key])) : [];
  return [String(error), JSON.stringify(error), ...own, error instanceof Error ? String(error.stack) + String(error.cause) : ""].join("\n");
}

describe("appGet (TEST-017)", () => {
  it("rethrows a reset with method, path and class only", async () => {
    const error = await thrown(playwrightError("read ECONNRESET"));
    expect(error).toBeInstanceOf(RequestFailed);
    expect((error as Error).message).toBe("GET /profiles/00000000-0000-4000-8000-000000000001 failed: ECONNRESET");
    expect((error as Error).cause).toBeUndefined();
    for (const secret of secrets) expect(everything(error)).not.toContain(secret);
  });

  it("classifies a timeout without the call log", async () => {
    const error = await thrown(playwrightError("Request timed out after 20000ms", "TimeoutError"));
    expect((error as Error).message).toBe("GET /profiles/00000000-0000-4000-8000-000000000001 failed: timeout");
    for (const secret of secrets) expect(everything(error)).not.toContain(secret);
  });

  it("never copies an unknown message, or a non-Error value", async () => {
    const error = await thrown(playwrightError(`unexpected ${cookie} refresh_token=unit-refresh-secret ${jwt}`));
    expect((error as Error).message).toBe("GET /profiles/00000000-0000-4000-8000-000000000001 failed: error");
    for (const secret of secrets) expect(everything(error)).not.toContain(secret);
    const value = await thrown({ cookie, refresh_token: "unit-refresh-secret", jwt });
    expect((value as Error).message).toBe("GET /profiles/00000000-0000-4000-8000-000000000001 failed: unknown");
    for (const secret of secrets) expect(everything(value)).not.toContain(secret);
  });

  it("returns the response unchanged when the call succeeds", async () => {
    const response = { status: () => 404 };
    const context = { get: (url: string, options: unknown) => { expect([url, options]).toEqual(["/likes?tab=sent", { maxRedirects: 0 }]); return Promise.resolve(response); } };
    expect(await appGet(context as unknown as APIRequestContext, "/likes?tab=sent", { maxRedirects: 0 })).toBe(response);
  });
});
