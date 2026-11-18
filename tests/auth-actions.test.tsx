// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { declineConfirmedAction, signInAction, signOutAction, signOutEverywhereAction, signUpAction } from "@/server/auth-actions";
import { authFieldMessages, newPasswordProblem, passwordHint, passwordMessages, validateAuthInput } from "@/lib/auth-validation";

const mocks = vi.hoisted(() => ({ mode: vi.fn(), create: vi.fn(), signUp: vi.fn(), signIn: vi.fn(), signOut: vi.fn(), redirect: vi.fn(), rpc: vi.fn(), reserve: vi.fn(), reserveSignUp: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/backend", () => ({ backendMode: mocks.mode }));
vi.mock("@/lib/supabase/server", () => ({ createServerSupabase: mocks.create }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/server/auth-rate", () => ({ reserveSignIn: mocks.reserve, reserveSignUp: mocks.reserveSignUp }));
// FIX-005: meets the sign-up rule (lowercase, uppercase, digit and symbol).
const password = "Fiction-pass-123";
const privateError = "private provider details";
const previous = { status: "idle" } as const;
function form(email: unknown = " fiction@example.invalid ", pass: unknown = password, next?: string) {
  const data = new FormData();
  if (typeof email === "string") data.set("email", email);
  if (typeof pass === "string") data.set("password", pass);
  if (next !== undefined) data.set("next", next);
  return data;
}
let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("CAMPUS_LINK_SITE_URL", "");
  fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network forbidden"));
  mocks.mode.mockReturnValue("supabase");
  mocks.create.mockResolvedValue({ auth: { signUp: mocks.signUp, signInWithPassword: mocks.signIn, signOut: mocks.signOut }, rpc: mocks.rpc });
  mocks.rpc.mockResolvedValue({ data: [{ account_status: "active", profile_completed: true }], error: null });
  mocks.reserve.mockResolvedValue("ok");
  mocks.reserveSignUp.mockResolvedValue("ok");
  mocks.signUp.mockResolvedValue({ data: {}, error: null });
  mocks.signIn.mockResolvedValue({ data: {}, error: null });
  mocks.signOut.mockResolvedValue({ error: null });
  mocks.redirect.mockImplementation((path: string) => { throw new Error(`REDIRECT:${path}`); });
});
afterEach(() => { expect(fetchSpy).not.toHaveBeenCalled(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("signup privacy and mappings", () => {
  it("returns byte-identical sent states for new/existing success and existing-account errors", async () => {
    const results = [];
    for (const result of [
      { data: { session: {}, user: { identities: [{}] } }, error: null },
      { data: { session: null, user: { identities: [{}] } }, error: null },
      { data: { session: null, user: { identities: [] } }, error: null },
      ...["user_already_exists", "email_exists"].map((code) => ({ data: null, error: { code, message: privateError } })),
    ]) {
      mocks.signUp.mockResolvedValueOnce(result);
      results.push(await signUpAction(previous, form()));
    }
    expect(results).toEqual(Array(5).fill({ status: "sent" }));
    expect(new Set(results.map((result) => JSON.stringify(result))).size).toBe(1);
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(mocks.signUp).toHaveBeenCalledWith({ email: "fiction@example.invalid", password });
  });
  it.each([
    [{ status: 429 }, "rate_limited"], [{ code: "over_email_send_rate_limit" }, "rate_limited"],
    [{ code: "over_request_rate_limit" }, "rate_limited"], [{ code: "weak_password" }, "invalid"],
    [{ code: "email_address_invalid" }, "invalid"], [{ code: "unexpected_failure" }, "unavailable"],
  ] as const)("maps signup error %# without leaking details", async (error, status) => {
    mocks.signUp.mockResolvedValue({ error: { ...error, message: privateError } });
    const result = await signUpAction(previous, form());
    expect(result.status).toBe(status);
    if ("code" in error && error.code === "weak_password") expect(result.fieldErrors).toEqual({ password: passwordMessages.rule });
    if ("code" in error && error.code === "email_address_invalid") expect(result.fieldErrors).toEqual({ email: authFieldMessages.email });
    expect(JSON.stringify(result)).not.toContain(password);
    expect(JSON.stringify(result)).not.toContain(privateError);
  });
  it("handles thrown signup/client failures without logging", async () => {
    const log = vi.spyOn(console, "error");
    mocks.signUp.mockRejectedValue(new Error(privateError));
    expect(await signUpAction(previous, form())).toEqual({ status: "unavailable" });
    mocks.create.mockRejectedValue(new Error(privateError));
    expect(await signUpAction(previous, form())).toEqual({ status: "unavailable" });
    expect(log).not.toHaveBeenCalled();
  });
  it.each(["https://campus.example", "https://campus.example:443", "https://campus.example:8443", "http://localhost:80", "http://localhost:3100", "http://127.0.0.1:3100"])("uses only an approved origin %s", async (origin) => {
    vi.stubEnv("CAMPUS_LINK_SITE_URL", origin);
    await signUpAction(previous, form());
    expect(mocks.signUp.mock.calls[0][0].options).toEqual({ emailRedirectTo: `${origin}/auth/confirm` });
  });
  it.each([undefined, "", "https://campus.example/", "https://campus.example/path", "https://campus.example?x=1", "https://campus.example#x", "https://user:pass@campus.example", "javascript:alert(1)", "http://example.com", "http://localhost", " https://campus.example", "https://campus.example\n"])("omits redirect option for %#", async (origin) => {
    vi.stubEnv("CAMPUS_LINK_SITE_URL", origin);
    await signUpAction(previous, form());
    expect(mocks.signUp.mock.calls[0][0]).not.toHaveProperty("options");
  });
});

describe("SEC-012 sign-up reservation", () => {
  it("reserves the typed address once before Auth, and never the sign-in limit", async () => {
    const order: string[] = [];
    mocks.reserveSignUp.mockImplementation(async () => { order.push("reserve"); return "ok"; });
    mocks.signUp.mockImplementation(async () => { order.push("signUp"); return { data: {}, error: null }; });
    expect(await signUpAction(previous, form())).toEqual({ status: "sent" });
    expect(mocks.reserveSignUp).toHaveBeenCalledExactlyOnceWith("fiction@example.invalid");
    expect(order).toEqual(["reserve", "signUp"]);
    expect(mocks.reserve).not.toHaveBeenCalled();
  });
  it.each([["rate_limited", "rate_limited"], ["unavailable", "unavailable"], [undefined, "unavailable"], ["other", "unavailable"]] as const)(
    "never calls Auth when the reservation answers %s", async (answer, status) => {
      mocks.reserveSignUp.mockResolvedValue(answer);
      expect(await signUpAction(previous, form())).toEqual({ status });
      expect(mocks.create).not.toHaveBeenCalled();
      expect(mocks.signUp).not.toHaveBeenCalled();
    });
  it("never calls Auth when the reservation throws, and logs nothing", async () => {
    const logs = ["log", "warn", "error", "info", "debug"].map((method) => vi.spyOn(console, method as "log").mockImplementation(() => {}));
    mocks.reserveSignUp.mockRejectedValue(new Error(privateError));
    const result = await signUpAction(previous, form());
    expect(result).toEqual({ status: "unavailable" });
    expect(JSON.stringify(result)).not.toContain(privateError);
    expect(mocks.signUp).not.toHaveBeenCalled();
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });
  it("keeps the same sent answer for a new and an existing address after the reservation", async () => {
    mocks.signUp.mockResolvedValueOnce({ data: { session: null, user: { identities: [{}] } }, error: null });
    const fresh = await signUpAction(previous, form());
    mocks.signUp.mockResolvedValueOnce({ data: null, error: { code: "user_already_exists", message: privateError } });
    const existing = await signUpAction(previous, form());
    expect(fresh).toEqual({ status: "sent" });
    expect(JSON.stringify(existing)).toBe(JSON.stringify(fresh));
    expect(mocks.reserveSignUp).toHaveBeenCalledTimes(2);
  });
});

describe("validation before client creation", () => {
  it.each([
    ["bad", password], ["a".repeat(243) + "@example.com", password], [null, password],
    ["a@b.co", "short"], ["a@b.co", "x".repeat(73)], ["a@b.co", "あ".repeat(24) + "x"], ["a@b.co", null],
  ])("rejects invalid input %# for both actions", async (email, pass) => {
    for (const action of [signUpAction, signInAction]) {
      const result = await action(previous, form(email, pass));
      expect(result.status).toBe("invalid");
      expect(Object.keys(result.fieldErrors ?? {})).not.toHaveLength(0);
      expect(JSON.stringify(result)).not.toContain(password);
    }
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.reserveSignUp).not.toHaveBeenCalled();
  });
  it("keeps sign-in's older checks: code points and Auth's 72 bytes, password spaces preserved (FIX-005)", async () => {
    expect(validateAuthInput("a@b.co", "😀".repeat(8), "signin").valid).toBe(true);
    expect(validateAuthInput("a@b.co", "😀".repeat(7), "signin").fieldErrors).toEqual({ password: authFieldMessages.password });
    expect(validateAuthInput("a@b.co", "あ".repeat(24), "signin").valid).toBe(true);
    expect(validateAuthInput("a@b.co", "あ".repeat(25), "signin").fieldErrors).toEqual({ password: authFieldMessages.passwordTooLong });
    expect(validateAuthInput("a@b.co", "a".repeat(72), "signin").valid).toBe(true);
    expect(validateAuthInput("a@b.co", "a".repeat(73), "signin").fieldErrors).toEqual({ password: authFieldMessages.password });
    await signInAction(previous, form("a@b.co", "  valid-pass  ")).catch(() => undefined);
    expect(mocks.signIn.mock.calls[0][0].password).toBe("  valid-pass  ");
  });
});

describe("new password rule (FIX-005)", () => {
  const long = `Aa1!${"a".repeat(68)}`;
  it.each([
    ["Aa1!aaa", "short"], ["", "short"], [`${long}a`, "long"],
    ["abcdefg1!", "uppercase"], ["ABCDEFG1!", "lowercase"], ["Abcdefgh!", "digit"], ["Abcdefg12", "symbol"],
    ["Abc defg1!", "characters"], ["Abcdefg1！", "characters"], ["Ａbcdefg1!", "characters"], ["Abcdefg1!あ", "characters"],
    ["Abcdefg1!	", "characters"], ["Abcdefg1!😀", "characters"],
  ] as const)("refuses %j as %s", (value, problem) => {
    expect(newPasswordProblem(value)).toBe(problem);
    expect(validateAuthInput("a@b.co", value, "signup").fieldErrors).toEqual({ password: passwordMessages[problem] });
  });
  it.each(["Aa1!aaaa", long, "Fiction-pass-123", "P@ssw0rd", "zZ9~`{}|", "Aa1\"'<>?/"])("accepts %j", (value) => {
    expect(newPasswordProblem(value)).toBeNull();
    expect(validateAuthInput("a@b.co", value, "signup").valid).toBe(true);
  });
  it("counts every printable ASCII symbol as a symbol", () => {
    for (let code = 0x21; code <= 0x7e; code++) {
      const symbol = String.fromCharCode(code);
      if (/[A-Za-z0-9]/.test(symbol)) continue;
      expect(newPasswordProblem(`Abcdefg1${symbol}`)).toBeNull();
    }
  });
  it("refuses a non-compliant sign-up before Auth with the field message, but signs in with an older-style password", async () => {
    expect(await signUpAction(previous, form("a@b.co", "password123"))).toEqual({ status: "invalid", fieldErrors: { password: passwordMessages.uppercase } });
    expect(mocks.signUp).not.toHaveBeenCalled();
    expect(mocks.reserveSignUp).not.toHaveBeenCalled();
    await expect(signInAction(previous, form("a@b.co", "password123"))).rejects.toThrow("REDIRECT:/");
    expect(mocks.signIn).toHaveBeenCalledWith({ email: "a@b.co", password: "password123" });
  });
  it("words the rule without jargon", () => {
    for (const text of [passwordHint, ...Object.values(passwordMessages), ...Object.values(authFieldMessages)]) {
      expect(text).not.toMatch(/UTF|バイト|byte|ASCII|JWT|RPC|トークン|token|aal/i);
    }
  });
});

describe("signin and signout", () => {
  // The fixed 'failed' answer time runs at once here; each wait is recorded instead.
  let waits: number[];
  beforeEach(() => {
    waits = [];
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((run: () => void, ms: number) => { waits.push(ms); run(); return 0; }) as never);
  });
  it("answers a deleted account and a wrong password at the same fixed time after the attempt starts", async () => {
    const now = vi.spyOn(Date, "now");
    mocks.signIn.mockResolvedValueOnce({ error: { code: "invalid_credentials", message: privateError } });
    now.mockReturnValueOnce(10_000).mockReturnValueOnce(10_120);   // the password check took 120 ms
    expect(await signInAction(previous, form())).toEqual({ status: "failed" });
    mocks.rpc.mockResolvedValueOnce({ data: [{ account_status: "deleted" }], error: null });
    now.mockReturnValueOnce(20_000).mockReturnValueOnce(20_900);   // sign-in, account read and global sign-out took 900 ms
    expect(await signInAction(previous, form())).toEqual({ status: "failed" });
    expect(waits).toEqual([1380, 600]);
    mocks.signIn.mockRejectedValueOnce(new Error(privateError));
    now.mockReturnValueOnce(30_000).mockReturnValueOnce(31_600);   // already past the fixed time: no wait
    expect(await signInAction(previous, form())).toEqual({ status: "failed" });
    expect(waits).toEqual([1380, 600]);
  });
  it("reserves the typed address once before Auth, and never on signup", async () => {
    const order: string[] = [];
    mocks.reserve.mockImplementation(async () => { order.push("reserve"); return "ok"; });
    mocks.signIn.mockImplementation(async () => { order.push("signIn"); return { data: {}, error: null }; });
    await expect(signInAction(previous, form())).rejects.toThrow("REDIRECT:/");
    expect(mocks.reserve).toHaveBeenCalledExactlyOnceWith("fiction@example.invalid");
    expect(order).toEqual(["reserve", "signIn"]);
    await signUpAction(previous, form());
    expect(mocks.reserve).toHaveBeenCalledOnce();
    expect(mocks.reserveSignUp).toHaveBeenCalledOnce();
  });
  it.each([["rate_limited", "rate_limited"], ["unavailable", "unavailable"], [undefined, "unavailable"], ["other", "unavailable"]] as const)(
    "never calls Auth when the reservation answers %s", async (answer, status) => {
      mocks.reserve.mockResolvedValue(answer);
      expect(await signInAction(previous, form())).toEqual({ status });
      expect(mocks.create).not.toHaveBeenCalled();
      expect(mocks.signIn).not.toHaveBeenCalled();
      expect(mocks.redirect).not.toHaveBeenCalled();
      expect(waits).toEqual([]);
    });
  it("never calls Auth when the reservation throws", async () => {
    mocks.reserve.mockRejectedValue(new Error(privateError));
    expect(await signInAction(previous, form())).toEqual({ status: "unavailable" });
    expect(mocks.signIn).not.toHaveBeenCalled();
  });
  it("never delays the other answers", async () => {
    mocks.signIn.mockResolvedValueOnce({ error: { status: 429 } });
    expect(await signInAction(previous, form())).toEqual({ status: "rate_limited" });
    mocks.rpc.mockResolvedValueOnce({ data: [], error: null });
    expect(await signInAction(previous, form())).toEqual({ status: "unavailable" });
    await expect(signInAction(previous, form("a@b.co", password, "/talk"))).rejects.toThrow("REDIRECT:/talk");
    expect(waits).toEqual([]);
  });
  it.each(["invalid_credentials", "email_not_confirmed", "user_not_found", "unknown"])("returns the same failed state for %s", async (code) => {
    mocks.signIn.mockResolvedValue({ error: { code, message: privateError } });
    expect(await signInAction(previous, form())).toEqual({ status: "failed" });
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
  it("maps thrown signin/client errors identically", async () => {
    mocks.signIn.mockRejectedValue(new Error(privateError));
    expect(await signInAction(previous, form())).toEqual({ status: "failed" });
    mocks.create.mockRejectedValue(new Error(privateError));
    expect(await signInAction(previous, form())).toEqual({ status: "failed" });
  });
  it.each([{ status: 429 }, { code: "over_email_send_rate_limit" }, { code: "over_request_rate_limit" }])("maps signin rate limiting %#", async (error) => {
    mocks.signIn.mockResolvedValue({ error });
    expect(await signInAction(previous, form())).toEqual({ status: "rate_limited" });
  });
  it.each(["/talk?x=1", "/a#b", "//evil.example", "/%5cevil", "/%2f%2fevil", "javascript:alert(1)", "/has space", "/%E0%A4%A", undefined])("redirects safely after signin %#", async (next) => {
    const expected = next === "/talk?x=1" || next === "/a#b" ? next : "/";
    await expect(signInAction(previous, form("a@b.co", password, next))).rejects.toThrow(`REDIRECT:${expected}`);
  });
  it.each(["active", "deactivated", "suspended", null])("lets a %s account through to its destination after one my_account read", async (accountStatus) => {
    mocks.rpc.mockResolvedValue({ data: [{ account_status: accountStatus, profile_completed: accountStatus !== null }], error: null });
    await expect(signInAction(previous, form("a@b.co", password, "/talk"))).rejects.toThrow("REDIRECT:/talk");
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("my_account", {});
    expect(mocks.signOut).not.toHaveBeenCalled();
  });
  it.each(["success", "error", "throw"])("ends every session of a deleted account and answers like a wrong password (signOut %s)", async (kind) => {
    mocks.rpc.mockResolvedValue({ data: [{ account_status: "deleted", profile_completed: true }], error: null });
    if (kind === "error") mocks.signOut.mockResolvedValue({ error: { message: privateError } });
    if (kind === "throw") mocks.signOut.mockRejectedValue(new Error(privateError));
    const deleted = await signInAction(previous, form("a@b.co", password, "/mypage"));
    mocks.signIn.mockResolvedValue({ error: { code: "invalid_credentials", message: privateError } });
    const wrongPassword = await signInAction(previous, form("a@b.co", password, "/mypage"));
    expect(deleted).toEqual({ status: "failed" });
    expect(JSON.stringify(deleted)).toBe(JSON.stringify(wrongPassword));
    expect(mocks.signOut).toHaveBeenCalledExactlyOnceWith({ scope: "global" });
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
  it.each([
    ["empty", { data: [], error: null }], ["two rows", { data: [{ account_status: "active" }, { account_status: "active" }], error: null }],
    ["no status", { data: [{}], error: null }], ["forbidden", { data: null, error: { code: "P0001", message: "forbidden" } }],
    ["expired", { data: null, error: { code: "PGRST301", message: privateError } }], ["outage", { data: null, error: { message: privateError } }],
  ])("fails closed when the account cannot be read (%s): ends only this new session", async (_kind, result) => {
    mocks.rpc.mockResolvedValue(result);
    const state = await signInAction(previous, form());
    expect(state).toEqual({ status: "unavailable" });
    expect(JSON.stringify(state)).not.toContain(privateError);
    expect(mocks.signOut).toHaveBeenCalledExactlyOnceWith({ scope: "local" });
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
  it("fails closed when the account read throws", async () => {
    mocks.rpc.mockRejectedValue(new Error(privateError));
    expect(await signInAction(previous, form())).toEqual({ status: "unavailable" });
    expect(mocks.signOut).toHaveBeenCalledExactlyOnceWith({ scope: "local" });
  });
  it("never reads the account when the password is refused", async () => {
    mocks.signIn.mockResolvedValue({ error: { code: "invalid_credentials", message: privateError } });
    await signInAction(previous, form());
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.signOut).not.toHaveBeenCalled();
  });
  it.each(["success", "error", "throw", "client-throw"])("signs out locally and redirects even on %s", async (kind) => {
    if (kind === "error") mocks.signOut.mockResolvedValue({ error: { message: privateError } });
    if (kind === "throw") mocks.signOut.mockRejectedValue(new Error(privateError));
    if (kind === "client-throw") mocks.create.mockRejectedValue(new Error(privateError));
    await expect(signOutAction()).rejects.toThrow("REDIRECT:/welcome");
    if (kind !== "client-throw") expect(mocks.signOut).toHaveBeenCalledWith({ scope: "local" });
  });
  it.each([
    ["signOutEverywhereAction", signOutEverywhereAction, "global", "/welcome", "/login?error=signout"],
    ["declineConfirmedAction", declineConfirmedAction, "local", "/login", "/login"],
  ] as const)("%s signs out with its scope and redirects even after a failure", async (_name, action, scope, destination, failed) => {
    for (const kind of ["success", "error", "throw", "client-throw"]) {
      mocks.signOut.mockReset().mockResolvedValue({ error: null });
      mocks.create.mockReset().mockResolvedValue({ auth: { signOut: mocks.signOut } });
      mocks.redirect.mockClear();
      if (kind === "error") mocks.signOut.mockResolvedValue({ error: { message: privateError } });
      if (kind === "throw") mocks.signOut.mockRejectedValue(new Error(privateError));
      if (kind === "client-throw") mocks.create.mockRejectedValue(new Error(privateError));
      const expected = kind === "success" ? destination : failed;
      await expect(action()).rejects.toThrow(new Error(`REDIRECT:${expected}`));
      expect(mocks.redirect).toHaveBeenCalledExactlyOnceWith(expected);
      if (kind === "client-throw") expect(mocks.signOut).not.toHaveBeenCalled();
      else expect(mocks.signOut).toHaveBeenCalledExactlyOnceWith({ scope });
    }
  });
  // FIX-002: auth-js answers { error } when the revoke fails and clears only this device's session.
  it.each([
    ["an error", "error", "/login?error=signout"],
    ["a throw", "throw", "/login?error=signout"],
    ["a client throw", "client-throw", "/login?error=signout"],
    ["success", "success", "/welcome"],
  ])("never lands a global sign-out with %s anywhere but its honest destination", async (_, kind, expected) => {
    if (kind === "error") mocks.signOut.mockResolvedValue({ data: null, error: { message: privateError, status: 500 } });
    if (kind === "throw") mocks.signOut.mockRejectedValue(new Error(privateError));
    if (kind === "client-throw") mocks.create.mockRejectedValue(new Error(privateError));
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
    await expect(signOutEverywhereAction()).rejects.toThrow(new Error(`REDIRECT:${expected}`));
    expect(mocks.redirect).toHaveBeenCalledExactlyOnceWith(expected);
    expect(JSON.stringify(mocks.redirect.mock.calls)).not.toContain(privateError);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
  it("keeps a failed local sign-out on /welcome", async () => {
    mocks.signOut.mockResolvedValue({ error: { message: privateError } });
    await expect(signOutAction()).rejects.toThrow(new Error("REDIRECT:/welcome"));
    expect(mocks.redirect).toHaveBeenCalledExactlyOnceWith("/welcome");
  });
  it("keeps the ordinary logout local", async () => {
    await expect(signOutAction()).rejects.toThrow("REDIRECT:/welcome");
    expect(mocks.signOut).toHaveBeenCalledExactlyOnceWith({ scope: "local" });
  });
  it("keeps every action inert in demo mode", async () => {
    mocks.mode.mockReturnValue("demo");
    expect(await signUpAction(previous, form())).toEqual({ status: "unavailable" });
    expect(await signInAction(previous, form())).toEqual({ status: "unavailable" });
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.reserveSignUp).not.toHaveBeenCalled();
    expect(await signOutAction()).toEqual({ status: "unavailable" });
    expect(await signOutEverywhereAction()).toEqual({ status: "unavailable" });
    expect(await declineConfirmedAction()).toEqual({ status: "unavailable" });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
});
