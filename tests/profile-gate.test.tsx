// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { profileGate } from "@/server/profile-gate";

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/server/rpc", () => ({ callRpc: mocks.rpc }));
const client = { rpc: vi.fn() };
let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.resetAllMocks();
  fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network forbidden"));
});
afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

describe("server profile gate", () => {
  it.each<[unknown, string]>([
    [{ code: "unauthenticated", data: null }, "unauthenticated"],
    [{ code: "ok", data: [{ profile_completed: true, private_value: "never returned" }] }, "completed"],
    [{ code: "ok", data: [{ profile_completed: false }] }, "incomplete"],
    [{ code: "ok", data: [{ profile_completed: true, account_status: "deactivated" }] }, "completed"],
    [{ code: "ok", data: [{ profile_completed: true, account_status: "suspended" }] }, "completed"],
    [{ code: "ok", data: [{ profile_completed: true, account_status: "deleted" }] }, "unavailable"],
    ...["not_available", "invalid_state", "already_pending", "already_connected", "rate_limited", "forbidden", "validation", "unavailable", "unexpected"].map<[unknown, string]>((code) => [{ code, data: null }, "unavailable"]),
    ...[[], [{}], [{ profile_completed: "true" }], [{ profile_completed: null }], [{ profile_completed: 1 }], [{ profile_completed: 0 }], [null], ["true"], [true], [{ profile_completed: true }, { profile_completed: true }], { profile_completed: true }, null].map<[unknown, string]>((data) => [{ code: "ok", data }, "unavailable"]),
  ])("returns only a gate string for response %#", async (response, expected) => {
    mocks.rpc.mockResolvedValue(response);
    expect(await profileGate(client)).toBe(expected);
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith(client, "my_account");
  });
  it("fails closed when the RPC throws", async () => {
    mocks.rpc.mockRejectedValue(new Error("private provider detail"));
    expect(await profileGate(client)).toBe("unavailable");
  });
});
