// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ mode: vi.fn(), create: vi.fn(), rpc: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/backend", () => ({ backendMode: m.mode }));
vi.mock("@/lib/supabase/server", () => ({ createServerSupabase: m.create }));
import { claimSubmission, releaseSubmission, decideSubmission, revokeVerification } from "@/server/admin-verification-actions";
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const age = { id, kind: "age", approve: true, reason: null, validUntil: null, expectedVersion: 1 };
const enrollment = { ...age, kind: "enrollment", validUntil: "2027-03-31" };
const revoke = { submissionId: id, reason: "document_invalid" };
let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.resetAllMocks(); vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-05T15:01:00Z"));
  fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network forbidden"));
  m.mode.mockReturnValue("supabase"); m.create.mockResolvedValue({ rpc: m.rpc });
  m.rpc.mockResolvedValue({ data: { ok: true, code: "ok", ref: id }, error: null });
});
afterEach(() => { expect(fetchSpy).not.toHaveBeenCalled(); vi.useRealTimers(); vi.restoreAllMocks(); });
it("demo creates no client for any action", async () => {
  m.mode.mockReturnValue("demo");
  for (const run of [() => claimSubmission(id), () => releaseSubmission(id), () => decideSubmission(enrollment), () => revokeVerification(revoke)]) expect(await run()).toEqual({ status: "unavailable" });
  expect(m.create).not.toHaveBeenCalled();
});
it.each([null, "bad", id.toUpperCase(), `${id}\n`, 42])("rejects malformed identifiers %#", async value => {
  expect(await claimSubmission(value)).toEqual({ status: "invalid" }); expect(await releaseSubmission(value)).toEqual({ status: "invalid" }); expect(m.create).not.toHaveBeenCalled();
});
it.each([null, {}, { ...age, kind: "unknown" }, { ...age, approve: "true" }, { ...age, expectedVersion: 1.1 }, { ...age, expectedVersion: -1 }, { ...age, expectedVersion: Infinity }, { ...age, expectedVersion: Number.MAX_SAFE_INTEGER + 1 },
  ...["free text", "OTHER", "unknown", "toString", "__proto__"].map(reason => ({ ...age, approve: false, reason })),
  ...["2026-11-05", "2026-11-06", "2026-02-30", "2027-02-30", "2027-13-01", "2027-3-31", "2027-03-31T12:00:00Z"].map(validUntil => ({ ...enrollment, validUntil }))])("rejects decision input before creating a client %#", async input => {
  expect(await decideSubmission(input)).toEqual({ status: "invalid" }); expect(m.create).not.toHaveBeenCalled();
});
it.each([null, {}, ...[null, "bad", id.toUpperCase(), `${id}\n`, 42].map(submissionId => ({ ...revoke, submissionId })),
  { userId: id, kind: "age", reason: revoke.reason }, ...["free text", "OTHER", "unknown", "constructor"].map(reason => ({ ...revoke, reason }))])("rejects revocation input before client %#", async input => {
  expect(await revokeVerification(input)).toEqual({ status: "invalid" }); expect(m.create).not.toHaveBeenCalled();
});
it("uses exact claim, release and revoke arguments", async () => {
  expect(await claimSubmission(id)).toEqual({ status: "ok" }); expect(m.rpc).toHaveBeenLastCalledWith("admin_claim_submission", { p_id: id });
  expect(await releaseSubmission(id)).toEqual({ status: "ok" }); expect(m.rpc).toHaveBeenLastCalledWith("admin_release_submission", { p_id: id });
  expect(await revokeVerification(revoke)).toEqual({ status: "ok" }); expect(m.rpc).toHaveBeenLastCalledWith("admin_revoke_verification", { p_submission: id, p_reason: "document_invalid" });
});
it("sends no supplied user id or kind when revoking a submission", async () => {
  expect(await revokeVerification({ ...revoke, userId: "untrusted", kind: "enrollment" })).toEqual({ status: "ok" });
  expect(m.rpc).toHaveBeenCalledExactlyOnceWith("admin_revoke_verification", { p_submission: id, p_reason: "document_invalid" });
});
it.each([
  [age, null, null], [enrollment, null, "2027-03-31T23:59:59+09:00"],
  [{ ...age, approve: false, reason: "document_mismatch", validUntil: "untrusted" }, "document_mismatch", null],
  [{ ...enrollment, approve: false, reason: "not_eligible" }, "not_eligible", null],
])("sends only the exact decision signature %#", async (input, reason, date) => {
  expect(await decideSubmission(input)).toEqual({ status: "ok" });
  expect(m.rpc).toHaveBeenCalledExactlyOnceWith("admin_decide_submission", { p_id: id, p_approve: input.approve, p_reason: reason, p_valid_until: date, p_expected_version: 1 });
});
it("accepts tomorrow after Tokyo midnight and a real leap day", async () => {
  expect(await decideSubmission({ ...enrollment, validUntil: "2026-11-07" })).toEqual({ status: "ok" });
  expect(await decideSubmission({ ...enrollment, validUntil: "2028-02-29" })).toEqual({ status: "ok" });
});
it.each(["not_available", "invalid_state", "already_pending", "already_connected", "rate_limited"])("maps refusal %s", async code => {
  m.rpc.mockResolvedValue({ data: { ok: false, code }, error: null });
  expect(await claimSubmission(id)).toEqual({ status: code === "not_available" || code === "invalid_state" ? "invalid_state" : "unavailable" });
});
it.each([[{ code: "P0001", message: "forbidden" }, "forbidden"], [{ code: "P0001", message: "validation" }, "invalid"], [{ code: "PGRST301", message: "private detail" }, "unauthenticated"], [{ message: "private detail" }, "unavailable"]])("contains errors %#", async (error, status) => {
  m.rpc.mockResolvedValue({ data: null, error }); expect(await claimSubmission(id)).toEqual({ status });
});
it("contains thrown provider and client failures", async () => {
  m.rpc.mockRejectedValue(new Error("provider secret")); expect(await claimSubmission(id)).toEqual({ status: "unavailable" });
  m.create.mockRejectedValue(new Error("client secret")); expect(await releaseSubmission(id)).toEqual({ status: "unavailable" });
});
