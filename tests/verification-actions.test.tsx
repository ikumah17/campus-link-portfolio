// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ create: vi.fn(), mode: vi.fn(), rpc: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/backend", () => ({ backendMode: m.mode }));
vi.mock("@/lib/supabase/server", () => ({ createServerSupabase: m.create }));
import { submitVerification, withdrawVerification } from "@/server/verification-actions";
let fetchSpy: ReturnType<typeof vi.spyOn>;
const id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
beforeEach(() => { vi.clearAllMocks(); m.mode.mockReturnValue("supabase"); m.create.mockResolvedValue({ rpc: m.rpc }); fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("forbidden")); });
afterEach(() => { expect(fetchSpy).not.toHaveBeenCalled(); vi.restoreAllMocks(); });
it("demo never creates a client", async () => { m.mode.mockReturnValue("demo"); expect(await submitVerification("age", ["synthetic:sample-1"])).toEqual({ status: "unavailable" }); expect(await withdrawVerification(id)).toEqual({ status: "unavailable" }); expect(m.create).not.toHaveBeenCalled(); });
it.each([[], ["synthetic:sample-1", "synthetic:sample-1"], ["synthetic:sample-1", "synthetic:sample-2", "synthetic:sample-3", "synthetic:sample-1"], ["synthetic:sample-4"], ["synthetic:sample-1\n"], ["../secret"], "synthetic:sample-1", new Array(1)])("rejects refs %j before client creation", async refs => { expect(await submitVerification("age", refs)).toEqual({ status: "invalid" }); expect(m.create).not.toHaveBeenCalled(); });
it("rejects bad kinds and UUIDs", async () => { expect(await submitVerification("other", ["synthetic:sample-1"])).toEqual({ status: "invalid" }); for(const value of [null, "bad", id.toUpperCase(), id + "\n"]) expect(await withdrawVerification(value)).toEqual({ status: "invalid" }); expect(m.create).not.toHaveBeenCalled(); });
it.each([ [ { data: { ok: true, code: "ok", ref: id }, error: null }, "ok" ], [ { data: null, error: { code: "P0001", message: "validation" } }, "invalid" ], [ { data: { ok: false, code: "invalid_state" }, error: null }, "invalid_state" ], [ { data: null, error: null, status: 401 }, "unauthenticated" ], [ { data: null, error: { message: "provider secret" } }, "unavailable" ] ])("maps results to fixed statuses", async (response, status) => { m.rpc.mockResolvedValue(response); expect(await submitVerification("age", ["synthetic:sample-1"])).toEqual({ status }); expect(m.rpc).toHaveBeenCalledWith("submit_verification", { p_kind: "age", p_document_refs: ["synthetic:sample-1"] }); expect(await withdrawVerification(id)).toEqual({ status }); expect(m.rpc).toHaveBeenCalledWith("withdraw_verification", { p_id: id }); });
it("maps not_available only for withdrawal and catches throws", async () => { m.rpc.mockResolvedValue({ data: { ok: false, code: "not_available" }, error: null }); expect(await withdrawVerification(id)).toEqual({ status: "invalid_state" }); expect(await submitVerification("age", ["synthetic:sample-1"])).toEqual({ status: "unavailable" }); m.create.mockRejectedValue(new Error("secret")); expect(await withdrawVerification(id)).toEqual({ status: "unavailable" }); });
