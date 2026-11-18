// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as route from "@/app/api/csp-report/route";

let fetchSpy: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network forbidden"));
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const url = "https://campus.example/api/csp-report";
const post = (body: BodyInit | null, type: string, headers: Record<string, string> = {}) =>
  new Request(url, { method: "POST", body, headers: { "content-type": type, cookie: "sb-token=fake-secret", "user-agent": "FakeAgent/1", "x-forwarded-for": "203.0.113.9", ...headers }, duplex: "half" } as RequestInit);
const logged = () => warn.mock.calls.map(([line]: unknown[]) => {
  expect(typeof line === "string" && line.startsWith("[csp-report] ")).toBe(true);
  return JSON.parse((line as string).slice("[csp-report] ".length));
});
function expectQuiet(response: Response) {
  expect(response.status).toBe(204);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(warn).not.toHaveBeenCalled();
}
function expectNoLeak() {
  const text = warn.mock.calls.flat().join("\n");
  for (const secret of ["secret=", "?", "token", "fake-secret", "FakeAgent", "203.0.113.9", "/evil/path", "sample", "#frag"]) expect(text.includes(secret)).toBe(false);
}
const legacy = {
  "csp-report": {
    "document-uri": "https://campus.example/talk/demo-4?mode=friends&secret=1#frag",
    referrer: "https://campus.example/?token=leak",
    "violated-directive": "script-src-elem 'self' 'nonce-abc'",
    "effective-directive": "script-src-elem",
    "original-policy": "script-src 'self' 'nonce-abc'",
    "blocked-uri": "https://evil.example:8443/evil/path?secret=1",
    disposition: "enforce",
    "script-sample": "sample",
    "status-code": 200,
  },
};
const modern = [{
  type: "csp-violation",
  age: 1,
  url: "https://campus.example/profiles/demo-1?secret=1",
  user_agent: "FakeAgent/1",
  body: {
    documentURL: "https://campus.example/profiles/demo-1?secret=1",
    referrer: "https://campus.example/?token=leak",
    effectiveDirective: "img-src",
    originalPolicy: "img-src 'self'",
    blockedURL: "https://cdn.evil.example/evil/path/x.png?secret=1",
    disposition: "report",
    sample: "sample",
    statusCode: 200,
  },
}, { type: "deprecation", body: { message: "ignored" } }];

describe("CSP report route", () => {
  it.each(["demo", "supabase"])("logs only the allowed fields of an application/csp-report body (%s)", async (mode) => {
    vi.stubEnv("CAMPUS_LINK_BACKEND", mode);
    const response = await route.POST(post(JSON.stringify(legacy), "application/csp-report"));
    expect(response.status).toBe(204);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("");
    expect(logged()).toEqual([{ directive: "script-src-elem", blocked: "https://evil.example:8443", document: "/talk/demo-4", disposition: "enforce" }]);
    expectNoLeak();
  });
  it("logs one line per csp-violation in an application/reports+json body", async () => {
    const response = await route.POST(post(JSON.stringify(modern), "application/reports+json; charset=utf-8"));
    expect(response.status).toBe(204);
    expect(logged()).toEqual([{ directive: "img-src", blocked: "https://cdn.evil.example", document: "/profiles/demo-1", disposition: "report" }]);
    expect(warn).toHaveBeenCalledOnce();
    expectNoLeak();
  });
  it.each([
    ["inline", "inline"], ["eval", "eval"], ["data:image/png;base64,secret=", "data:"], ["blob:https://campus.example/uuid?secret=1", "blob:"],
    ["", "unknown"], ["not a url ?secret=1", "unknown"], [42, "unknown"],
  ])("reduces blocked URI %j to %s", async (blocked, expected) => {
    const body = { "csp-report": { ...legacy["csp-report"], "blocked-uri": blocked } };
    await route.POST(post(JSON.stringify(body), "application/csp-report"));
    expect(logged()[0].blocked).toBe(expected);
    expectNoLeak();
  });
  it("falls back to violated-directive's name and replaces unexpected values", async () => {
    const body = { "csp-report": { "violated-directive": "style-src 'self'", "document-uri": "nonsense", disposition: "?secret=1" } };
    await route.POST(post(JSON.stringify(body), "application/csp-report"));
    expect(logged()).toEqual([{ directive: "style-src", blocked: "unknown", document: "unknown", disposition: "unknown" }]);
    const injected = { "csp-report": { "effective-directive": "img-src\n[csp-report] forged", "document-uri": "https://campus.example/a%0Ab?x" } };
    warn.mockClear();
    await route.POST(post(JSON.stringify(injected), "application/csp-report"));
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0][0]).includes("\n")).toBe(false);
    expect(logged()[0]).toMatchObject({ directive: "img-src", document: "/a%0Ab" });
  });
  it("refuses an oversized body without logging", async () => {
    const big = JSON.stringify({ "csp-report": { ...legacy["csp-report"], pad: "a".repeat(16 * 1024) } });
    expectQuiet(await route.POST(post(big, "application/csp-report")));
  });
  it("refuses a declared length over the bound or a malformed one without reading", async () => {
    for (const length of [String(16 * 1024 + 1), "-1", "abc"]) {
      const request = post(JSON.stringify(legacy), "application/csp-report");
      Object.defineProperty(request, "headers", { value: new Headers({ "content-type": "application/csp-report", "content-length": length }) });
      expectQuiet(await route.POST(request));
      expect(request.bodyUsed).toBe(false);
    }
  });
  it("stops at the bound when the declared length is false", async () => {
    const encoder = new TextEncoder();
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(encoder.encode(pulled === 1 ? '{"csp-report":{"pad":"' : "a".repeat(4096)));
        if (pulled > 100) controller.close();
      },
    });
    const request = post(stream, "application/csp-report");
    Object.defineProperty(request, "headers", { value: new Headers({ "content-type": "application/csp-report", "content-length": "10" }) });
    expectQuiet(await route.POST(request));
    expect(pulled).toBeLessThan(10);
  });
  it.each([
    ["not json", "application/csp-report"], ["[]", "application/csp-report"], ['{"csp-report":"x"}', "application/csp-report"],
    ['{"type":"csp-violation"}', "application/reports+json"], ['[1,null,{"type":"csp-violation","body":3}]', "application/reports+json"],
    [JSON.stringify(legacy), "application/json"], [JSON.stringify(legacy), "text/plain"], [new Uint8Array([0xff, 0xfe]), "application/csp-report"],
  ])("answers 204 without logging for a bad body %#", async (body, type) => {
    expectQuiet(await route.POST(post(body as BodyInit, type)));
  });
  it("answers 204 for an empty body", async () => {
    expectQuiet(await route.POST(post(null, "application/csp-report")));
  });
  it.each(["GET", "PUT", "PATCH", "DELETE", "OPTIONS"] as const)("answers 405 to %s", async (method) => {
    const response = route[method]();
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    expect(warn).not.toHaveBeenCalled();
  });
});
