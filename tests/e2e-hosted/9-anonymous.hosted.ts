import { test, expect } from "@playwright/test";
import { environment, evidence } from "./state";
import { totp } from "./totp";

test("RFC 6238 helper matches published SHA1 vectors", () => {
  // RFC's public test key, not an account credential; compare six-digit suffixes.
  const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  for (const [seconds, code] of [[59, "287082"], [1111111109, "081804"], [1111111111, "050471"], [1234567890, "005924"], [2000000000, "279037"], [20000000000, "353130"]] as const) {
    expect(totp(secret, seconds * 1000)).toBe(code);
  }
});

test("publishable-key-only requests are refused and private is not exposed", async () => {
  const env = environment();
  const headers = { apikey: env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, "Content-Type": "application/json" };
  const statuses: Record<string, number> = {};
  for (const path of ["profiles", "messages", "schools", "rpc/my_account"]) {
    const response = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/${path}${path.startsWith("rpc/") ? "" : "?select=*&limit=1"}`, {
      method: path.startsWith("rpc/") ? "POST" : "GET", headers,
      ...(path.startsWith("rpc/") ? { body: "{}" } : {}), signal: AbortSignal.timeout(30_000),
    });
    statuses[path] = response.status;
    expect(response.status, path).toBe(401);
    expect((await response.json()).code, path).toBe("42501");
  }
  const response = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/staff_roles?select=*`, { headers: { ...headers, "Accept-Profile": "private" }, signal: AbortSignal.timeout(30_000) });
  expect(response.status).toBe(406);
  expect((await response.json()).code).toBe("PGRST106");
  evidence("anonymous", { status: "pass", statuses, privateSchemaStatus: response.status });
});
