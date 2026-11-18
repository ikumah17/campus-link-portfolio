import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { newPasswordProblem } from "@/lib/auth-validation";
import { cleanup, setup, teardown, insertRunMessage, clearRunEmailConfirmation, runPassword } from "./lifecycle";
import type { Retention } from "./state";
import { totp } from "./totp";
import { realtimeFlags } from "./realtime";

const mocks = vi.hoisted(() => ({ state: { runId: "abcdef123456", users: [] as { id: string; email: string }[], revocationRooms: [] as { path: string; participants: [number, number] }[], concurrency: undefined as { adminId: string; roleUsers: number[] } | undefined, retention: undefined as Retention | undefined }, mode: null as "prepare" | "verify" | null, evidence: vi.fn(), unlink: vi.fn(), roleCleanup: vi.fn() }));
vi.mock("./concurrency", () => ({ cleanupConcurrencyRoles: mocks.roleCleanup }));
vi.mock("node:fs", () => ({ existsSync: () => true, unlinkSync: mocks.unlink }));
vi.mock("./state", () => ({
  localDir: ".e2e-hosted", readState: () => mocks.state, retentionMode: () => mocks.mode, saveState: (state: typeof mocks.state) => { mocks.state = state; }, resetEvidence: vi.fn(), evidence: mocks.evidence,
  environment: () => ({ NEXT_PUBLIC_SUPABASE_URL: "https://exampleprojectrefabc.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "unit-only-placeholder" }),
}));
const id = "12345678-1234-4123-8123-123456789abc";
const email = "e2e-abcdef123456-0@example.invalid";
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
let request: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.state = { runId: "abcdef123456", users: [{ id, email }], revocationRooms: [], concurrency: undefined, retention: undefined };
  mocks.mode = null;
  request = vi.fn(); vi.stubGlobal("fetch", request);
});

describe("hosted revocation privileged boundaries", () => {
  const room = { path: `/talk/${id}`, participants: [0, 1] as [number, number] };
  function pair() {
    mocks.state.users.push({ id: "22345678-1234-4123-8123-123456789abc", email: "e2e-abcdef123456-1@example.invalid" });
    mocks.state.revocationRooms.push(room);
  }
  it("refuses an unregistered conversation or sender before using the server credential", async () => {
    await expect(insertRunMessage(room, 0)).rejects.toThrow("ownership mismatch");
    pair();
    await expect(insertRunMessage(room, 2)).rejects.toThrow("ownership mismatch");
    mocks.state.users[1].email = "e2e-admin@example.invalid";
    await expect(insertRunMessage(room, 0)).rejects.toThrow("ownership mismatch");
    expect(request).not.toHaveBeenCalled();
  });
  it("makes exactly the authorized INSERT and retains only status and an error code on refusal", async () => {
    pair();
    request.mockResolvedValueOnce(response({ code: "42501", message: "private-provider-body" }, 403));
    expect(await insertRunMessage(room, 1)).toEqual({ status: 403, ok: false, code: "42501" });
    expect(request).toHaveBeenCalledOnce();
    const [url, options] = request.mock.calls[0];
    expect(url).toBe("https://exampleprojectrefabc.supabase.co/rest/v1/messages");
    expect(options.method).toBe("POST");
    expect(JSON.parse(options.body)).toMatchObject({ conversation_id: id, sender_id: mocks.state.users[1].id });
  });
  it("does not expose arbitrary response text as an error code", async () => {
    pair();
    request.mockResolvedValueOnce(response({ code: "private-provider-body" }, 400));
    expect(await insertRunMessage(room, 0)).toEqual({ status: 400, ok: false, code: "unclassified_provider_error" });
  });
  it("checks exact Auth identity before unconfirming and verifies the actual result", async () => {
    request.mockResolvedValueOnce(response({ id, email, email_confirmed_at: "2026-11-09" }))
      .mockResolvedValueOnce(response({ access_token: "never-return-this" }))
      .mockResolvedValueOnce(response({ id, email, email_confirmed_at: "2026-11-09" }));
    expect(await clearRunEmailConfirmation(0)).toEqual({ status: 200, ok: true, code: null, cleared: false });
    expect(request.mock.calls[1][1].method).toBe("PUT");
    expect(JSON.parse(request.mock.calls[1][1].body)).toEqual({ email_confirm: false });
    expect(request.mock.calls[2][1].method).toBe("GET");
  });
  it("refuses to change an Auth identity that disagrees with the exact run ledger", async () => {
    request.mockResolvedValueOnce(response({ id, email: "unrelated@example.invalid" }));
    await expect(clearRunEmailConfirmation(0)).rejects.toThrow("ownership mismatch");
    expect(request).toHaveBeenCalledOnce();
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("hosted cleanup ownership and verification", () => {
  it("retains every user and object when the protected admin was not restored", async () => {
    mocks.state.concurrency = { adminId: id, roleUsers: [0] };
    mocks.roleCleanup.mockRejectedValueOnce(new Error("e2e-admin admin not restored"));
    await expect(cleanup()).rejects.toThrow("e2e-admin admin not restored");
    expect(request).not.toHaveBeenCalled();
    expect(mocks.unlink).not.toHaveBeenCalled();
  });
  it("refuses a ledger entry outside the exact run before any network request", async () => {
    mocks.state.users[0].email = "e2e-admin@example.invalid";
    await expect(cleanup()).rejects.toThrow("Cleanup ownership mismatch");
    expect(request).not.toHaveBeenCalled(); expect(mocks.unlink).not.toHaveBeenCalled();
  });
  it("refuses deletion when the provider identity does not match the ledger", async () => {
    request.mockResolvedValueOnce(response({ email: "unrelated@example.invalid" }));
    await expect(cleanup()).rejects.toThrow("Cleanup refused an unowned user");
    expect(request).toHaveBeenCalledTimes(1); expect(mocks.unlink).not.toHaveBeenCalled();
  });
  it("refuses unexpected nested storage paths", async () => {
    request.mockResolvedValueOnce(response({ email })).mockResolvedValueOnce(response([{ id: "object", name: "../other.webp" }]));
    await expect(cleanup()).rejects.toThrow("Unexpected run storage object");
    expect(request).toHaveBeenCalledTimes(2); expect(mocks.unlink).not.toHaveBeenCalled();
  });
  it("deletes only exact user objects, verifies empty storage and missing user", async () => {
    request.mockResolvedValueOnce(response({ email }))
      .mockResolvedValueOnce(response([{ id: "object", name: `${id}.webp` }]))
      .mockResolvedValueOnce(response([])).mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(response({})).mockResolvedValueOnce(response({}, 404));
    await cleanup();
    const calls = request.mock.calls as [string, RequestInit][];
    expect(calls[2][0]).toContain("/storage/v1/object/profile-photos");
    expect(JSON.parse(calls[2][1].body as string)).toEqual({ prefixes: [`${id}/${id}.webp`] });
    expect(calls[4][0]).toContain(`/auth/v1/admin/users/${id}`);
    expect(calls[4][1].method).toBe("DELETE");
    expect(mocks.evidence).toHaveBeenCalledWith("cleanup", expect.objectContaining({ usersDeleted: 1, storageEmpty: true, verified: true }));
    expect(mocks.unlink).toHaveBeenCalledOnce();
  });
  it("retains the ledger and does not delete the user when storage remains", async () => {
    request.mockResolvedValueOnce(response({ email })).mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(response([{ id: "object", name: `${id}.webp` }]));
    await expect(cleanup()).rejects.toThrow("Storage cleanup verification failed");
    expect(request).toHaveBeenCalledTimes(3); expect(mocks.unlink).not.toHaveBeenCalled();
  });
  it("persists the exact planned ID before creation and cleans it after a lost response", async () => {
    mocks.state.users = [];
    let plannedId = "";
    request.mockImplementationOnce((_url: string, options: RequestInit) => {
      const body = JSON.parse(options.body as string);
      plannedId = body.id;
      expect(mocks.state.users[0]).toEqual(expect.objectContaining({ id: body.id, email: body.email }));
      return Promise.reject(new Error("sensitive provider details"));
    }).mockImplementationOnce(() => Promise.resolve(response({ email: mocks.state.users[0].email })))
      .mockResolvedValueOnce(response([])).mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(response({})).mockResolvedValueOnce(response({}, 404));
    await expect(setup()).rejects.toThrow("Hosted setup/cleanup transport failed (POST)");
    expect(request.mock.calls[4][0]).toContain(`/auth/v1/admin/users/${plannedId}`);
    expect(request.mock.calls[4][1].method).toBe("DELETE");
    expect(mocks.evidence).toHaveBeenLastCalledWith("cleanup", expect.objectContaining({ verified: true, usersDeleted: 1 }));
  });
});
describe("hosted retention ledger phases", () => {
  const prepared = (phase: Retention["phase"]) => {
    mocks.state.users.push({ id: "22345678-1234-4123-8123-123456789abc", email: "e2e-abcdef123456-1@example.invalid" });
    mocks.state.retention = { phase, photos: [[], []] };
  };
  it("never cleans around an unresolved --apply", async () => {
    prepared("applying");
    await expect(cleanup()).rejects.toThrow("Retention apply unresolved");
    await expect(setup()).rejects.toThrow("Retention apply unresolved");
    expect(request).not.toHaveBeenCalled(); expect(mocks.unlink).not.toHaveBeenCalled();
  });
  it("verify setup continues only the exact prepared ledger, without cleanup or new users", async () => {
    mocks.mode = "verify";
    await expect(setup()).rejects.toThrow("needs the prepared run ledger");
    prepared("prepared");
    await setup();
    mocks.state.users[1].email = "e2e-admin@example.invalid";
    await expect(setup()).rejects.toThrow("ownership mismatch");
    expect(request).not.toHaveBeenCalled();
  });
  it("prepare keeps U and K for the backdate; a failed prepare is cleaned up", async () => {
    mocks.mode = "prepare";
    prepared("prepared");
    await teardown();
    expect(request).not.toHaveBeenCalled(); expect(mocks.unlink).not.toHaveBeenCalled();
    expect(mocks.evidence).toHaveBeenCalledWith("retentionLedger", { kept: true, phase: "prepared" });
    mocks.state.retention = undefined;
    request.mockImplementation((url: string) => Promise.resolve(url.includes("/storage/") ? response([]) : response({}, 404)));
    await teardown();
    expect(mocks.unlink).toHaveBeenCalledOnce();
  });
  it("verify cleans up only after a full pass", async () => {
    mocks.mode = "verify";
    for (const phase of ["prepared", "applied"] as const) {
      mocks.state.users = [{ id, email }]; prepared(phase);
      await teardown();
    }
    expect(request).not.toHaveBeenCalled(); expect(mocks.unlink).not.toHaveBeenCalled();
    mocks.state.retention = { phase: "verified", photos: [[], []] };
    request.mockImplementation((url: string) => Promise.resolve(url.includes("/storage/") ? response([]) : response({}, 404)));
    await teardown();
    expect(mocks.evidence).toHaveBeenCalledWith("cleanup", expect.objectContaining({ usersDeleted: 2, verified: true }));
    expect(mocks.unlink).toHaveBeenCalledOnce();
  });
});
it("matches all RFC 6238 SHA1 vectors (six-digit suffix)", () => {
  for (const [seconds, code] of [[59, "287082"], [1111111109, "081804"], [1111111111, "050471"], [1234567890, "005924"], [2000000000, "279037"], [20000000000, "353130"]] as const) {
    expect(totp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", seconds * 1000)).toBe(code);
  }
});
it("recognizes Phoenix v2 INSERT and a confirmed subscription without retaining payloads", () => {
  expect(realtimeFlags(JSON.stringify([null, null, "realtime:chat", "postgres_changes", { data: { type: "INSERT" } }]))).toEqual({ insert: true, subscribed: false, ready: false, systemError: false, errorCode: null });
  expect(realtimeFlags(JSON.stringify([null, "1", "realtime:chat", "phx_reply", { status: "ok", response: { postgres_changes: [{ id: 1 }] } }]))).toEqual({ insert: false, subscribed: true, ready: false, systemError: false, errorCode: null });
  expect(realtimeFlags(JSON.stringify([null, "1", "realtime:chat", "phx_reply", { status: "error", response: {} }]))).toEqual({ insert: false, subscribed: false, ready: false, systemError: true, errorCode: "unknown_realtime_error" });
  expect(realtimeFlags(JSON.stringify([null, null, "realtime:chat", "system", { status: "ok", extension: "postgres_changes" }]))).toEqual({ insert: false, subscribed: false, ready: true, systemError: false, errorCode: null });
  expect(realtimeFlags(JSON.stringify([null, null, "realtime:chat", "system", { status: "error", extension: "postgres_changes" }])).systemError).toBe(true);
});

describe("run passwords (FIX-005)", () => {
  it("meet the sign-up rule and differ on every call", () => {
    const passwords = Array.from({ length: 50 }, runPassword);
    for (const password of passwords) expect(newPasswordProblem(password)).toBeNull();
    expect(new Set(passwords).size).toBe(50);
  });
});
