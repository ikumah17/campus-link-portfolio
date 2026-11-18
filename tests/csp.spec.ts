import { expect, test, type Page } from "@playwright/test";
import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

// Discover the complete page inventory, including nested and seeded dynamic pages.
const root = join(process.cwd(), "src/app");
function pages(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry): string[] => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return pages(path);
    if (entry.name !== "page.tsx") return [];
    const route = relative(root, dir).split(sep).join("/").replace("profiles/[id]", "profiles/demo-1").replace("talk/[id]", "talk/demo-4");
    return [`/${route}`];
  });
}

async function observeCsp(page: Page) {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && /content.security.policy|\bcsp\b|violat.*directive|refused to (?:execute|load|apply|connect)/i.test(message.text())) {
      errors.push(message.text().replace(/'nonce-[^']+'/g, "'nonce-<redacted>'"));
    }
  });
  await page.addInitScript(() => {
    const state = window as unknown as { cspViolations: string[] };
    state.cspViolations = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      state.cspViolations.push(`${event.effectiveDirective}: ${event.blockedURI}`);
    });
  });
  return errors;
}
async function violations(page: Page) {
  return page.evaluate(() => (window as unknown as { cspViolations: string[] }).cspViolations);
}
function nonceFrom(policy: string | undefined) {
  const nonce = policy?.match(/'nonce-([^']+)'/)?.[1];
  expect(Boolean(nonce)).toBe(true);
  return nonce!;
}

for (const route of [...pages(root), "/profiles/missing-csp-profile", "/talk/missing-csp-room", "/not-found-csp"]) {
  test(`CSP allows rendering and hydration on ${route}`, async ({ page }) => {
    const errors = await observeCsp(page);
    const response = await page.goto(route);
    const nonce = nonceFrom(response?.headers()["content-security-policy"]);
    await expect(page.locator("h1")).toBeVisible();
    // Wait for framework loading and each page's initial requests to settle.
    await page.waitForLoadState("networkidle");
    expect(await page.locator("script[nonce]").evaluateAll((scripts, expected) => scripts.length > 0 && scripts.every((script) => (script as HTMLScriptElement).nonce === expected), nonce)).toBe(true);
    expect(await violations(page)).toEqual([]);
    expect(errors).toEqual([]);
  });
}

test("nonce changes on reload and Discover client interactions run", async ({ page }) => {
  const errors = await observeCsp(page);
  const first = await page.goto("/");
  const firstNonce = nonceFrom(first?.headers()["content-security-policy"]);
  const like = page.getByRole("button", { name: "あおいにいいね" });
  await like.click();
  await expect(page.getByText("いいね済み")).toBeVisible();
  const second = await page.reload();
  expect(nonceFrom(second?.headers()["content-security-policy"]) === firstNonce).toBe(false);
  await page.waitForLoadState("networkidle");
  expect(await violations(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test("blocks an injected inline script without a nonce", async ({ page }) => {
  await observeCsp(page);
  // Insert into the actual HTML response: DevTools evaluation has script privileges
  // that an untrusted parser-inserted script must never inherit.
  await page.route("http://127.0.0.1:3100/", async (route) => {
    const response = await route.fetch();
    const html = await response.text();
    expect(html.includes("<head>")).toBe(true);
    await route.fulfill({ response, body: html.replace("<head>", "<head><script>window.cspInjectedScriptRan = true</script>") });
  });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "あおいにいいね" })).toBeVisible();
  await page.waitForLoadState("networkidle");
  await expect.poll(() => violations(page)).toContain("script-src-elem: inline");
  expect(await page.evaluate(() => "cspInjectedScriptRan" in window)).toBe(false);
});

test("pages name the CSP report endpoint, which answers 204 without a session", async ({ page, request }) => {
  const response = await page.goto("/");
  expect(response?.headers()["reporting-endpoints"]).toBe('csp-endpoint="/api/csp-report"');
  expect(response?.headers()["content-security-policy"]).toContain("report-uri /api/csp-report; report-to csp-endpoint;");
  const report = await request.post("/api/csp-report", {
    headers: { "content-type": "application/csp-report" },
    data: JSON.stringify({ "csp-report": { "effective-directive": "img-src", "blocked-uri": "inline", "document-uri": "http://127.0.0.1:3100/", disposition: "enforce" } }),
  });
  expect(report.status()).toBe(204);
  expect(report.headers()["cache-control"]).toBe("no-store");
  expect((await request.get("/api/csp-report")).status()).toBe(405);
});
