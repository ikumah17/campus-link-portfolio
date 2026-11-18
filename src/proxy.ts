import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { backendMode } from "@/lib/backend";
import { buildCsp, CSP_REPORT_PATH, newNonce, REPORTING_ENDPOINTS } from "@/lib/csp";
import { safeNextPath } from "@/lib/safe-next";
import { supabasePublicConfig } from "@/lib/supabase/config";
import { sessionCookieOptions } from "@/lib/supabase/cookie-options";

export async function proxy(request: NextRequest) {
  const demo = backendMode() === "demo";
  // Invalid Supabase config must still fail closed, before creating a response.
  const publicConfig = demo ? undefined : supabasePublicConfig();
  const nonce = newNonce();
  const csp = buildCsp(nonce, { dev: process.env.NODE_ENV === "development", supabaseUrl: publicConfig?.url });
  function nextResponse() {
    // Re-read cookies after every refresh while retaining this request's nonce.
    const headers = new Headers(request.headers);
    headers.set("x-nonce", nonce);
    headers.set("Content-Security-Policy", csp);
    const next = NextResponse.next({ request: { headers } });
    next.headers.set("Content-Security-Policy", csp);
    next.headers.set("Reporting-Endpoints", REPORTING_ENDPOINTS);
    return next;
  }
  if (!publicConfig) return nextResponse();

  const { url, publishableKey } = publicConfig;
  let response = nextResponse();
  const client = createServerClient(url, publishableKey, {
    cookieOptions: sessionCookieOptions(),
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(cookiesToSet, headers) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        const updated = nextResponse();
        // Preserve previous writes if the library calls setAll more than once.
        response.cookies.getAll().forEach((cookie) => updated.cookies.set(cookie));
        response.headers.forEach((value, name) => {
          if (["cache-control", "expires", "pragma"].includes(name)) updated.headers.set(name, value);
        });
        cookiesToSet.forEach(({ name, value, options }) => updated.cookies.set(name, value, options));
        Object.entries(headers).forEach(([name, value]) => updated.headers.set(name, value));
        updated.headers.set("Content-Security-Policy", csp);
        response = updated;
      },
    },
  });
  // getClaims verifies signatures; getSession contents must never authorize a request.
  const { data, error } = await client.auth.getClaims();
  const path = request.nextUrl.pathname;
  // Browsers send CSP reports without cookies, so the report route is public at its exact path only (SEC-009).
  // FIX-008: the terms and privacy policy are static and must be readable before sign-up, at their exact paths only.
  const publicPath = ["/welcome", "/login", "/signup", "/auth", "/settings/account/deleted", "/terms", "/privacy", CSP_REPORT_PATH].includes(path) || path.startsWith("/auth/") || path.startsWith("/media/");
  if (publicPath || (!error && data?.claims)) return response;

  // Absolute on purpose: Next's proxy adapter parses Location without a base (a relative one throws Invalid URL) and
  // then rewrites a same-host URL to its path and query, so the browser gets a relative Location (FIX-001).
  const login = new URL("/login", request.url);
  const next = safeNextPath(path + request.nextUrl.search);
  if (next) login.searchParams.set("next", next);
  const redirect = NextResponse.redirect(login);
  redirect.headers.set("Content-Security-Policy", csp);
  redirect.headers.set("Reporting-Endpoints", REPORTING_ENDPOINTS);
  response.cookies.getAll().forEach((cookie) => redirect.cookies.set(cookie));
  for (const name of ["cache-control", "expires", "pragma"]) {
    const value = response.headers.get(name);
    if (value) redirect.headers.set(name, value);
  }
  return redirect;
}

export const config = {
  // Only top-level public files skip the proxy: a nested path such as /talk/x.png is a page and needs CSP and session.
  // SEC-015: exactly /api/photos skips it too. Next copies a proxied body into memory (up to 10 MB) before the route
  // runs, so the route's FIX-002 gate could not keep anonymous or concurrent photo bodies out of memory. The route
  // itself refuses a cross-origin, unauthenticated or stale-session request with no-store before reading the body.
  // SEC-016: every dot is written [.], so none can match any character (favicon.ico let /faviconxico skip the proxy).
  // MOBILE-API-001: every path under /api/mobile/ skips it too, for the same reason and because those routes take only
  // a Bearer token: the proxy's cookie session and /login redirect do not apply (docs/42 §2.1).
  matcher: ["/((?!_next/static|_next/image|favicon[.]ico|api/photos$|api/mobile/|[^/]+[.](?:svg|png|jpg|jpeg|gif|webp|ico|avif|bmp)$).*)"],
};
