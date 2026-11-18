import { createAuthApi, parseAnswer } from "../src/api";
import { authFieldMessages, authMessages, passwordMessages } from "../src/shared";

const jwt = "aaa.bbb.ccc";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("auth API client", () => {
  it("posts JSON credentials to the MOBILE-API-001 routes without cookies or a token", async () => {
    const fetcher = jest.fn(async () => json({ status: "sent" }));
    const api = createAuthApi("http://192.168.1.10:3000", fetcher);
    await api.signUp("student@example.ac.jp", "password123");
    await api.signIn("student@example.ac.jp", "password123");
    const calls = fetcher.mock.calls as unknown as [string, RequestInit][];
    expect(calls.map(([url]) => url)).toEqual([
      "http://192.168.1.10:3000/api/mobile/auth/signup",
      "http://192.168.1.10:3000/api/mobile/auth/signin",
    ]);
    for (const [, init] of calls) {
      expect(init.method).toBe("POST");
      expect(init.credentials).toBe("omit");
      expect(init.headers).toEqual({ "Content-Type": "application/json", Accept: "application/json" });
      expect(JSON.parse(String(init.body))).toEqual({ email: "student@example.ac.jp", password: "password123" });
    }
  });

  it.each(["failed", "rate_limited", "unavailable", "invalid"] as const)("keeps the web's %s refusal", async (status) => {
    const api = createAuthApi("http://host:3000", async () => json({ status }, 400));
    const answer = await api.signIn("a@b.cd", "password123");
    expect(answer).toEqual({ status });
    expect(authMessages[status]).toBeTruthy();
  });

  it("returns the session of a successful sign-in", async () => {
    const api = createAuthApi("http://host:3000", async () => json({ status: "ok", session: {
      access_token: jwt, refresh_token: "r1", token_type: "bearer", expires_in: 3600, expires_at: 1900000000,
    } }));
    expect(await api.signIn("a@b.cd", "password123")).toEqual({
      status: "ok", session: { access_token: jwt, refresh_token: "r1", expires_in: 3600, expires_at: 1900000000 },
    });
  });

  it("answers the same sent for sign-up", async () => {
    const api = createAuthApi("http://host:3000", async () => json({ status: "sent" }));
    expect(await api.signUp("a@b.cd", "password123")).toEqual({ status: "sent" });
  });

  it("uses the shared field messages, never the server's text", () => {
    expect(parseAnswer("signin", { status: "invalid", fieldErrors: { email: "<b>x</b>", password: "y" } })).toEqual({
      status: "invalid", fieldErrors: { email: authFieldMessages.email, password: authFieldMessages.password },
    });
  });

  it("keeps a server password message only when it is a shared one (FIX-005)", () => {
    expect(parseAnswer("signup", { status: "invalid", fieldErrors: { password: passwordMessages.symbol } })).toEqual({
      status: "invalid", fieldErrors: { password: passwordMessages.symbol },
    });
    expect(parseAnswer("signup", { status: "invalid", fieldErrors: { password: "<b>weak</b>" } })).toEqual({
      status: "invalid", fieldErrors: { password: passwordMessages.rule },
    });
    expect(parseAnswer("signin", { status: "invalid", fieldErrors: { password: authFieldMessages.passwordTooLong } })).toEqual({
      status: "invalid", fieldErrors: { password: authFieldMessages.passwordTooLong },
    });
  });

  it.each([
    ["a network error", async () => { throw new TypeError("Network request failed"); }],
    ["an HTML page", async () => new Response("<html></html>", { status: 200, headers: { "Content-Type": "text/html" } })],
    ["a demo-mode 404", async () => new Response(null, { status: 404 })],
    ["a broken JSON body", async () => new Response("{", { status: 200, headers: { "Content-Type": "application/json" } })],
    ["an unknown status", async () => json({ status: "maybe" })],
  ])("maps %s to unavailable", async (_name, fetcher) => {
    const api = createAuthApi("http://host:3000", fetcher as () => Promise<Response>);
    expect(await api.signIn("a@b.cd", "password123")).toEqual({ status: "unavailable" });
  });

  it("refuses answers that do not fit the route", () => {
    expect(parseAnswer("signin", { status: "sent" })).toEqual({ status: "unavailable" });
    expect(parseAnswer("signup", { status: "ok", session: { access_token: jwt, refresh_token: "r" } })).toEqual({ status: "unavailable" });
    expect(parseAnswer("signin", { status: "ok", session: { access_token: "not-a-jwt", refresh_token: "r" } })).toEqual({ status: "unavailable" });
    expect(parseAnswer("signin", { status: "ok" })).toEqual({ status: "unavailable" });
    expect(parseAnswer("signin", null)).toEqual({ status: "unavailable" });
  });

  it("gives up after the request timeout", async () => {
    jest.useFakeTimers();
    try {
      const fetcher = (_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
      const answer = createAuthApi("http://host:3000", fetcher).signIn("a@b.cd", "password123");
      jest.advanceTimersByTime(15_000);
      expect(await answer).toEqual({ status: "unavailable" });
    } finally {
      jest.useRealTimers();
    }
  });
});
