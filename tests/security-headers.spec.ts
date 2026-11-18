import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1440, height: 900 } });

for (const path of ["/", "/welcome", "/profiles/demo-1", "/not-found-security-headers"]) {
  test(`security headers on ${path}`, async ({ page }) => {
    const response = await page.goto(path);
    expect(response).not.toBeNull();
    if (!response) throw new Error(`No response for ${path}`);
    if (path === "/not-found-security-headers") expect(response.status()).toBe(404);

    const headers = response.headers();
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(headers["permissions-policy"]).toBe(
      "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()",
    );
    expect(headers["cross-origin-opener-policy"]).toBe("same-origin");
    expect(headers["x-powered-by"]).toBeUndefined();
    // SEC-002: nonce policies now come from Proxy rather than next.config.ts.
    expect(Boolean(headers["content-security-policy"]?.includes("'strict-dynamic'"))).toBe(true);
    expect(headers["strict-transport-security"]).toBeUndefined();
  });
}
