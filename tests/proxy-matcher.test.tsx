// @vitest-environment node
// SECREVIEW-001 L-1: only top-level public files may skip the proxy (CSP, session refresh, login redirect).
// SEC-015: /api/photos skips it too, so Next does not buffer an upload body before the route; nothing else changed.
// SEC-016: every dot is written [.], so dotless lookalikes such as /faviconxico and /xxpng run the proxy.
// MOBILE-API-001: every path under /api/mobile/ skips it as well (Bearer-only JSON routes); nothing else changed.
import { describe, expect, it } from "vitest";
import * as staticInfo from "next/dist/build/analysis/get-page-static-info";
import type { ProxyMatcher } from "next/dist/build/analysis/get-page-static-info";
import { getMiddlewareRouteMatcher } from "next/dist/shared/lib/router/utils/middleware-route-matcher";
import { config } from "@/proxy";
// Next exports this at runtime but leaves it out of its type declarations.
const { getMiddlewareMatchers } = staticInfo as unknown as { getMiddlewareMatchers(matchers: string[], nextConfig: object): ProxyMatcher[] };

// The matcher before SEC-015, compiled the same way, to prove every other path is still matched as before.
const BEFORE_SEC_015 = "/((?!_next/static|_next/image|favicon.ico|[^/]+\.(?:svg|png|jpg|jpeg|gif|webp|ico|avif|bmp)$).*)";
// The SEC-015 matcher, exactly as written. Next kept its \\. as a literal dot, but favicon.ico's dot matched any
// character, so /faviconxico skipped the proxy.
const BEFORE_SEC_016 = "/((?!_next/static|_next/image|favicon.ico|api/photos$|[^/]+\\.(?:svg|png|jpg|jpeg|gif|webp|ico|avif|bmp)$).*)";
// The SEC-016 matcher, before MOBILE-API-001 added the api/mobile/ exclusion.
const BEFORE_MOBILE = "/((?!_next/static|_next/image|favicon[.]ico|api/photos$|[^/]+[.](?:svg|png|jpg|jpeg|gif|webp|ico|avif|bmp)$).*)";
const MOBILE_PATHS = ["/api/mobile/auth/signin", "/api/mobile/auth/signup", "/api/mobile/photos",
  "/api/mobile/photos/00000000-0000-4000-8000-000000000000", "/api/mobile/photos/x.webp", "/api/mobile/", "/api/mobile/unknown/x"];
const FAVICON_LOOKALIKES = ["/faviconxico", "/favicon-ico", "/favicon_ico", "/faviconxicox", "/faviconxico/x"];
const EXTENSION_LOOKALIKES = ["/xxpng", "/demo-profile-1xsvg", "/photo_webp", "/aavif", "/xjpeg", "/x-gif", "/x~ico"];
const compile = (matcher: string[]) => {
  const matches = getMiddlewareRouteMatcher(getMiddlewareMatchers(matcher, {}));
  return (path: string) => matches(path, { headers: {} } as never, {});
};
// Every page and route handler under src/app, with sample dynamic segments.
const APP_PATHS = [
  "/", "/welcome", "/login", "/signup", "/privacy", "/terms", "/onboarding", "/mypage", "/mypage/profile", "/search", "/likes", "/requests",
  "/verification", "/talk", "/talk/00000000-0000-4000-8000-000000000000", "/profiles/00000000-0000-4000-8000-000000000000",
  "/settings/account", "/settings/account/deleted", "/settings/blocks", "/settings/privacy",
  "/auth/confirm", "/auth/confirmed", "/media/photos/00000000-0000-4000-8000-000000000000",
  "/api/realtime-token", "/api/csp-report",
  "/admin", "/admin/accounts", "/admin/affiliations", "/admin/mfa", "/admin/staff", "/admin/reports", "/admin/verifications",
  "/admin/reports/00000000-0000-4000-8000-000000000000", "/admin/verifications/00000000-0000-4000-8000-000000000000",
  "/admin/documents/00000000-0000-4000-8000-000000000000/1",
];

describe("proxy matcher", () => {
  const matcher = new RegExp(`^${config.matcher[0]}$`);
  const proxied = compile(config.matcher);
  const before = compile([BEFORE_SEC_015]);

  it("still skips Next assets and the top-level public images", () => {
    for (const path of ["/_next/static/chunk.js", "/_next/image", "/favicon.ico", "/demo-profile-1.svg", "/photo.webp", "/photo.avif"]) {
      expect(matcher.test(path), path).toBe(false);
      expect(proxied(path), path).toBe(false);
    }
  });

  it("runs on nested paths that end in an image extension, which are pages or route handlers", () => {
    for (const path of ["/talk/x.png", "/profiles/a.svg", "/admin/reports/r.webp", "/settings/account/x.jpg", "/media/photos/p.webp"]) {
      expect(matcher.test(path), path).toBe(true);
      expect(proxied(path), path).toBe(true);
    }
    for (const path of ["/", "/talk", "/admin", "/media/photos/00000000-0000-4000-8000-000000000000"]) {
      expect(matcher.test(path), path).toBe(true);
    }
  });

  it("changes only the two dots of the SEC-015 matcher, apart from the MOBILE-API-001 exclusion", () => {
    expect(BEFORE_MOBILE).toBe(BEFORE_SEC_016.replace("favicon.ico", "favicon[.]ico").replace("+\\.", "+[.]"));
    expect(config.matcher[0]).toBe(BEFORE_MOBILE.replace("api/photos$|", "api/photos$|api/mobile/|"));
    expect(config.matcher[0]).not.toContain("\\");
  });

  it("runs on dotless lookalikes of favicon.ico, which the SEC-015 matcher skipped", () => {
    const sec015 = compile([BEFORE_SEC_016]);
    for (const path of [...FAVICON_LOOKALIKES, ...FAVICON_LOOKALIKES.map((path) => `${path}.rsc`)]) {
      expect(sec015(path), path).toBe(false);
      expect(proxied(path), path).toBe(true);
    }
    // A data route never matched the old exclusion, which sees the whole /_next/data/... path.
    for (const path of FAVICON_LOOKALIKES) expect(proxied(`/_next/data/build${path}.json`), path).toBe(true);
    for (const path of FAVICON_LOOKALIKES) expect(matcher.test(path), path).toBe(true);
  });

  it("still runs on dotless lookalikes of the image extensions", () => {
    const sec015 = compile([BEFORE_SEC_016]);
    for (const path of [...EXTENSION_LOOKALIKES, ...EXTENSION_LOOKALIKES.flatMap((path) => [`${path}.rsc`, `/_next/data/build${path}.json`])]) {
      expect(sec015(path), path).toBe(true);
      expect(proxied(path), path).toBe(true);
    }
    for (const path of EXTENSION_LOOKALIKES) expect(matcher.test(path), path).toBe(true);
  });

  it("differs from the SEC-015 matcher only on the favicon lookalikes", () => {
    const sec015 = compile([BEFORE_SEC_016]);
    const paths = [...APP_PATHS, ...APP_PATHS.flatMap((path) => [`${path}.rsc`, `${path}/`, `/_next/data/build${path === "/" ? "/index" : path}.json`]),
      "/api/photos", "/api/photos/", "/api/photos/x", "/api/photosx", "/_next/static/chunk.js", "/_next/static/x/y.css", "/_next/image",
      "/_next/image?url=x", "/favicon.ico", "/favicon.icox", "/demo-profile-1.svg", "/photo.webp", "/photo.avif", "/x.bmp", "/x.y.png",
      "/talk/x.png", "/profiles/a.svg", "/x.PNG", "/.png", "/x.pngx"];
    for (const path of paths) expect(proxied(path), path).toBe(sec015(path));
  });

  it("skips exactly /api/photos, which the old matcher ran on", () => {
    expect(before("/api/photos")).toBe(true);
    expect(proxied("/api/photos")).toBe(false);
    expect(matcher.test("/api/photos")).toBe(false);
  });

  it("still runs on every app path it ran on before", () => {
    for (const path of APP_PATHS) {
      expect(before(path), path).toBe(true);
      expect(proxied(path), path).toBe(true);
    }
  });

  it("agrees with the old matcher everywhere else, including RSC and data forms", () => {
    const paths = [...APP_PATHS, ...APP_PATHS.flatMap((path) => [`${path}.rsc`, `${path}/`, `/_next/data/build${path === "/" ? "/index" : path}.json`]),
      "/api/photos/", "/api/photos/x", "/api/photosx", "/API/photos", "/api/photos.rsc", "/api/%70hotos", "/x/api/photos",
      "/_next/static/chunk.js", "/_next/image", "/favicon.ico", "/demo-profile-1.svg", "/talk/x.png"];
    for (const path of paths) expect(proxied(path), path).toBe(before(path));
  });

  it("skips every path under /api/mobile/, which the SEC-016 matcher ran on", () => {
    const sec016 = compile([BEFORE_MOBILE]);
    for (const path of MOBILE_PATHS) {
      expect(sec016(path), path).toBe(true);
      expect(proxied(path), path).toBe(false);
      expect(matcher.test(path), path).toBe(false);
    }
  });

  it("still runs on /api/mobile itself and on lookalikes of the mobile prefix", () => {
    for (const path of ["/api/mobile", "/api/mobilex", "/api/mobile.rsc", "/api/mobilephotos", "/API/mobile/photos", "/x/api/mobile/photos",
      "/api/%6Dobile/photos", "/_next/data/build/api/mobile/photos.json", "/api/photos/mobile/x"]) {
      expect(proxied(path), path).toBe(true);
      expect(matcher.test(path), path).toBe(true);
    }
  });

  it("agrees with the SEC-016 matcher on every path outside /api/mobile/", () => {
    const sec016 = compile([BEFORE_MOBILE]);
    const paths = [...APP_PATHS, ...APP_PATHS.flatMap((path) => [`${path}.rsc`, `${path}/`, `/_next/data/build${path === "/" ? "/index" : path}.json`]),
      ...FAVICON_LOOKALIKES, ...EXTENSION_LOOKALIKES, "/api/photos", "/api/photos/", "/api/photos/x", "/api/mobile", "/api/mobilex",
      "/_next/static/chunk.js", "/_next/image", "/favicon.ico", "/demo-profile-1.svg", "/talk/x.png"];
    for (const path of paths) expect(proxied(path), path).toBe(sec016(path));
  });
});
