import { expect, test } from "@playwright/test";

// SECREVIEW-001: whole-app checks of response headers that no other suite pins (demo build).

// Every page is rendered per request (the root layout awaits connection()), so none may be stored by a shared cache.
for (const path of ["/", "/welcome", "/login", "/auth/confirmed", "/mypage", "/mypage/profile", "/talk", "/likes", "/settings/privacy", "/admin", "/admin/accounts", "/profiles/demo-1"]) {
  test(`private, no-store page response on ${path}`, async ({ request }) => {
    const response = await request.get(path, { maxRedirects: 0 });
    expect(response.status()).toBeLessThan(500);
    const cacheControl = response.headers()["cache-control"] ?? "";
    expect(cacheControl).toContain("no-store");
    expect(cacheControl).toContain("private");
  });
}

// L-1: a nested page path ending in an image extension goes through the proxy and gets the nonce CSP.
for (const path of ["/talk/x.png", "/profiles/a.svg"]) {
  test(`nonce CSP on the image-like page path ${path}`, async ({ request }) => {
    const response = await request.get(path, { maxRedirects: 0 });
    expect(response.headers()["content-security-policy"] ?? "").toContain("'strict-dynamic'");
  });
}

// The top-level public files still skip the proxy.
test("top-level public image is served without the page CSP", async ({ request }) => {
  const response = await request.get("/demo-profile-1.svg");
  expect(response.status()).toBe(200);
  expect(response.headers()["content-security-policy"]).toBeUndefined();
});
