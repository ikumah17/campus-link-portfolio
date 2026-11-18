// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startTotpEnrollment, verifyTotp } from "@/server/mfa-actions";

const mocks = vi.hoisted(() => ({ mode: vi.fn(), create: vi.fn(), list: vi.fn(), enroll: vi.fn(), unenroll: vi.fn(), verify: vi.fn(), rpc: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/backend", () => ({ backendMode: mocks.mode }));
vi.mock("@/lib/supabase/server", () => ({ createServerSupabase: mocks.create }));
const factor = (id: string, status = "unverified", created_at = "2026-11-01", factor_type = "totp") => ({ id, status, created_at, factor_type });
const qrCode = "data:image/svg+xml;utf-8,%3Csvg%3E%3C/svg%3E";
const secret = "FICTIONALTESTKEY";
let fetchSpy: ReturnType<typeof vi.spyOn>;
let logs: ReturnType<typeof vi.spyOn>[];
beforeEach(() => {
  vi.resetAllMocks();
  fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network forbidden"));
  logs = ["log", "warn", "error", "info", "debug"].map((method) => vi.spyOn(console, method as "log").mockImplementation(() => {}));
  mocks.mode.mockReturnValue("supabase");
  mocks.create.mockResolvedValue({ auth: { mfa: { listFactors: mocks.list, enroll: mocks.enroll, unenroll: mocks.unenroll, challengeAndVerify: mocks.verify } }, rpc: mocks.rpc });
  mocks.list.mockResolvedValue({ data: { all: [factor("pending")], totp: [] }, error: null });
  mocks.enroll.mockResolvedValue({ data: { id: "private-factor", type: "totp", totp: { qr_code: qrCode, secret, uri: "private-uri" } }, error: null });
  mocks.unenroll.mockResolvedValue({ error: null });
  mocks.verify.mockResolvedValue({ data: { access_token: "never-return" }, error: null });
  mocks.rpc.mockResolvedValue({ data: { ok: true, code: "ok", ref: null }, error: null });
});
afterEach(() => { expect(fetchSpy).not.toHaveBeenCalled(); for (const log of logs) expect(log).not.toHaveBeenCalled(); vi.restoreAllMocks(); });

describe("TOTP actions", () => {
  it("keeps both actions inert in demo mode", async () => {
    mocks.mode.mockReturnValue("demo");
    expect(await startTotpEnrollment()).toEqual({ status: "unavailable" });
    expect(await verifyTotp("123456")).toEqual({ status: "unavailable" });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it.each([null, undefined, 123456, {}, "", "12345", "1234567", "１２３４５６", " 123456", "123456\n", "abcdef"])("validates code before creating a client %#", async (code) => {
    expect(await verifyTotp(code)).toEqual({ status: "invalid_code" });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("uses only the server factor and returns no session tokens", async () => {
    expect(await verifyTotp("012345")).toEqual({ status: "ok" });
    expect(mocks.verify).toHaveBeenCalledWith({ factorId: "pending", code: "012345" });
    expect(mocks.list).toHaveBeenCalledWith();
  });
  it("reserves one attempt through the user's client after choosing the factor and before Auth verifies (SEC-006)", async () => {
    const order: string[] = [];
    mocks.list.mockImplementation(async () => { order.push("list"); return { data: { all: [factor("pending")] }, error: null }; });
    mocks.rpc.mockImplementation(async () => { order.push("reserve"); return { data: { ok: true, code: "ok", ref: null }, error: null }; });
    mocks.verify.mockImplementation(async () => { order.push("verify"); return { data: {}, error: null }; });
    expect(await verifyTotp("123456")).toEqual({ status: "ok" });
    expect(order).toEqual(["list", "reserve", "verify"]);
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("reserve_mfa_attempt", {});
    expect(JSON.stringify(mocks.rpc.mock.calls)).not.toContain("123456");
  });
  it.each([
    ["rate_limited", { data: { ok: false, code: "rate_limited", ref: null }, error: null }, "rate_limited"],
    ["another refusal", { data: { ok: false, code: "invalid_state", ref: null }, error: null }, "unavailable"],
    ["forbidden", { data: null, error: { code: "P0001", message: "forbidden" } }, "unavailable"],
    ["expired", { data: null, error: { code: "PGRST301", message: secret } }, "unavailable"],
    ["missing RPC", { data: null, error: { code: "PGRST202", message: secret }, status: 404 }, "unavailable"],
    ["malformed", { data: { ok: true }, error: null }, "unavailable"],
    ["empty", { data: null, error: null }, "unavailable"],
    ["rows", { data: [], error: null }, "unavailable"],
  ])("never calls verify when the reservation is %s", async (_label, answer, status) => {
    mocks.rpc.mockResolvedValue(answer);
    expect(await verifyTotp("123456")).toEqual({ status });
    expect(mocks.verify).not.toHaveBeenCalled();
  });
  it("never calls verify when the reservation throws", async () => {
    mocks.rpc.mockRejectedValue(new Error(secret));
    expect(await verifyTotp("123456")).toEqual({ status: "unavailable" });
    expect(mocks.verify).not.toHaveBeenCalled();
  });
  it("prefers verified TOTP over newer pending or other factor types", async () => {
    mocks.list.mockResolvedValue({ data: { all: [factor("new", "unverified", "2026-11-06"), factor("phone", "verified", "2026-11-06", "phone"), factor("verified", "verified")] }, error: null });
    await verifyTotp("123456");
    expect(mocks.verify).toHaveBeenCalledWith({ factorId: "verified", code: "123456" });
    expect(await startTotpEnrollment()).toEqual({ status: "already_enrolled" });
    expect(mocks.enroll).not.toHaveBeenCalled();
    expect(mocks.unenroll).not.toHaveBeenCalled();
  });
  it("selects the newest pending TOTP from all, not the verified-only totp bucket", async () => {
    mocks.list.mockResolvedValue({ data: { all: [factor("old"), factor("new", "unverified", "2026-11-06"), factor("middle", "unverified", "2026-11-03")], totp: [] }, error: null });
    await verifyTotp("123456");
    expect(mocks.verify).toHaveBeenCalledWith({ factorId: "new", code: "123456" });
  });
  it("removes only pending TOTP before enrollment and returns exactly the presentation fields", async () => {
    const order: string[] = [];
    mocks.list.mockResolvedValue({ data: { all: [factor("first"), factor("phone", "unverified", "2026-11-01", "phone"), factor("second")] }, error: null });
    mocks.unenroll.mockImplementation(async ({ factorId }: { factorId: string }) => { order.push(factorId); return { error: null }; });
    mocks.enroll.mockImplementation(async () => { order.push("enroll"); return { data: { type: "totp", id: "private-factor", totp: { qr_code: qrCode, secret, uri: "private-uri" } }, error: null }; });
    expect(await startTotpEnrollment()).toEqual({ status: "enroll", qrCode, secret });
    expect(order).toEqual(["first", "second", "enroll"]);
    expect(mocks.enroll).toHaveBeenCalledWith({ factorType: "totp" });
  });
  it.each(["https://example.invalid/qr.svg", "data:text/html,secret", "", null])("rejects non-SVG or missing QR %#", async (qr_code) => {
    mocks.enroll.mockResolvedValue({ data: { type: "totp", totp: { qr_code, secret } }, error: null });
    expect(await startTotpEnrollment()).toEqual({ status: "unavailable" });
  });
  it.each(["", "  ", null, 123])("rejects missing secret %#", async (secret) => {
    mocks.enroll.mockResolvedValue({ data: { type: "totp", totp: { qr_code: qrCode, secret } }, error: null });
    expect(await startTotpEnrollment()).toEqual({ status: "unavailable" });
  });
  it.each([
    [{ code: "mfa_verification_failed" }, "invalid_code"], [{ code: "mfa_challenge_expired" }, "invalid_code"],
    [{ status: 429 }, "rate_limited"], [{ code: "over_request_rate_limit" }, "rate_limited"],
    [{ name: "AuthSessionMissingError" }, "unauthenticated"], [{ code: "session_not_found" }, "unauthenticated"],
    [{ code: "refresh_token_not_found" }, "unauthenticated"], [{ status: 401 }, "unauthenticated"],
    [{ code: "session_expired" }, "unauthenticated"], [{ code: "refresh_token_already_used" }, "unauthenticated"],
    [{ code: "mfa_verification_failed", status: 401 }, "invalid_code"],
    [{ code: "unknown" }, "unavailable"],
  ])("maps provider failure %# without details", async (error, status) => {
    mocks.verify.mockResolvedValue({ error: { ...error, message: `${secret} private provider details` } });
    expect(await verifyTotp("123456")).toEqual({ status });
  });
  it.each(["list", "unenroll", "enroll"] as const)("stops enrollment on %s errors", async (method) => {
    for (const [error, status] of [[{ name: "AuthSessionMissingError" }, "unauthenticated"], [{ status: 429 }, "unavailable"], [{ message: secret }, "unavailable"]] as const) {
      const mock = mocks[method];
      mock.mockResolvedValueOnce({ data: null, error });
      expect(await startTotpEnrollment()).toEqual({ status });
    }
  });
  it("handles list errors, absent data, no factors and other factor types", async () => {
    mocks.list.mockResolvedValueOnce({ error: { code: "session_not_found" } });
    expect(await verifyTotp("123456")).toEqual({ status: "unauthenticated" });
    for (const data of [null, { all: [] }, { all: [factor("phone", "verified", "2026-11-01", "phone")] }]) {
      mocks.list.mockResolvedValue({ data, error: null });
      expect(await verifyTotp("123456")).toEqual({ status: "unavailable" });
    }
    expect(mocks.verify).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it.each(["create", "list", "enroll", "unenroll", "verify"] as const)("contains thrown %s errors without logs", async (method) => {
    mocks[method].mockRejectedValue(new Error(secret));
    if (method !== "verify") expect(await startTotpEnrollment()).toEqual({ status: "unavailable" });
    if (method !== "enroll" && method !== "unenroll") expect(await verifyTotp("123456")).toEqual({ status: "unavailable" });
  });
});
