// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
vi.mock("server-only", () => ({}));
import { callRpc, RPC_NAMES, type RpcClient } from "@/server/rpc";

// Keep the narrow adapter structurally compatible with the real SDK.
type Assert<T extends true> = T;
type SdkCompatible = Assert<SupabaseClient extends RpcClient ? true : false>;
const compatible: SdkCompatible = true;
let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => { fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network forbidden")); });
afterEach(() => { expect(fetchSpy).not.toHaveBeenCalled(); vi.restoreAllMocks(); });
const clientFor = (data: unknown, error: { code?: string; message?: string } | null = null, status = 200) => ({ rpc: vi.fn().mockResolvedValue({ data, error, status }) });

describe("RPC gateway mapping", () => {
  it("accepts the SDK type and includes the documented public RPCs", () => {
    expect(compatible).toBe(true);
    expect(RPC_NAMES).toContain("admin_upsert_department");
    expect(RPC_NAMES).toContain("admin_list_affiliations");
    expect(RPC_NAMES).toContain("admin_list_suspended_accounts");
    expect(new Set(RPC_NAMES).size).toBe(RPC_NAMES.length);
  });
  it.each(["fake-row-id", null])("maps a successful rpc_outcome ref %s and forwards args", async (ref) => {
    const client = clientFor({ ok: true, code: "ok", ref, internal: "not returned" });
    expect(await callRpc(client, "send_message", { p_body: "hello" })).toEqual({ code: "ok", data: { ref } });
    expect(client.rpc).toHaveBeenCalledWith("send_message", { p_body: "hello" });
  });
  it.each(["not_available", "invalid_state", "already_pending", "already_connected", "rate_limited", "mfa_required"])("maps committed refusal %s", async (code) => {
    expect(await callRpc(clientFor({ ok: false, code, ref: null }), "send_message")).toEqual({ code, data: null });
  });
  it.each([{ rows: [] }, { rows: [{ user_id: "fake-user" }] }])("maps set-returning rows %#", async ({ rows }) => {
    expect(await callRpc(clientFor(rows), "discover_profiles")).toEqual({ code: "ok", data: rows });
  });
  it.each(["forbidden", "validation"])("maps exact P0001 %s", async (code) => {
    expect(await callRpc(clientFor(null, { code: "P0001", message: code }, 400), "update_profile")).toEqual({ code, data: null });
  });
  it.each(["PGRST301", "PGRST302"])("maps JWT error %s", async (code) => {
    expect(await callRpc(clientFor(null, { code, message: "private error" }, 400), "my_account")).toEqual({ code: "unauthenticated", data: null });
  });
  it("maps HTTP 401 even without a parsed error", async () => {
    expect(await callRpc(clientFor(null, null, 401), "my_account")).toEqual({ code: "unauthenticated", data: null });
  });
  it.each([
    { code: "P0001", message: "forbidden with private DB text" },
    { code: "P0001", message: "not_available" },
    { code: "23505", message: "private DB text" },
    { code: "XX000", message: "validation" },
  ])("does not leak unrecognised database errors %#", async (error) => {
    const result = await callRpc(clientFor(null, error, 400), "my_account");
    expect(result).toEqual({ code: "unavailable", data: null });
    expect(JSON.stringify(result)).not.toContain(error.message);
  });
  it.each([null, "private DB text", {}, { ok: false, code: "unknown", ref: "private DB text" }, { ok: true, code: "ok", ref: 42 }, { ok: true, code: "forbidden", ref: null }])("fails closed on malformed results %#", async (data) => {
    expect(await callRpc(clientFor(data), "my_account")).toEqual({ code: "unavailable", data: null });
  });
  it("maps thrown transport failures without logging or returning the exception", async () => {
    const log = vi.spyOn(console, "error");
    const client = { rpc: vi.fn().mockRejectedValue(new Error("private DB text")) };
    expect(await callRpc(client, "my_account")).toEqual({ code: "unavailable", data: null });
    expect(log).not.toHaveBeenCalled();
  });
  it("rejects unknown names before calling the client without echoing input", async () => {
    const client = clientFor([]);
    await expect(callRpc(client, "unknown_private_name")).rejects.toThrow("Unknown RPC name");
    expect(client.rpc).not.toHaveBeenCalled();
  });
});
