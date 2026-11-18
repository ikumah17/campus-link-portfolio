import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Session, cleanupConcurrencyRoles, race, registerConcurrency, safeCode, summary, type Result } from "./concurrency";

const mocks = vi.hoisted(() => ({ request: vi.fn(), save: vi.fn(),
  state: { runId: "abcdef123456", users: [{ id: "12345678-1234-4123-8123-123456789abc", email: "e2e-abcdef123456-0@example.invalid", password: "unit-only-password" }],
    concurrency: undefined as { adminId: string; roleUsers: number[] } | undefined } }));
vi.mock("node:https", () => ({ request: mocks.request }));
vi.mock("./state", () => ({
  environment: () => ({ NEXT_PUBLIC_SUPABASE_URL: "https://exampleprojectrefabc.supabase.co", NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "unit-public", SUPABASE_SERVICE_ROLE_KEY: "unit-server-must-never-be-used" }),
  credentials: () => ({ admin: { email: "e2e-admin@example.invalid", password: "unit-admin-password" }, adminTotpSecret: "unit-unused" }),
  readState: () => mocks.state, saveState: (value: typeof mocks.state) => { mocks.state = value; mocks.save(value); },
}));
const adminId = "22345678-1234-4123-8123-123456789abc";
let port = 1000;
function respond(body: unknown, status = 200) {
  mocks.request.mockImplementationOnce((_url, _options, callback) => {
    const req = new EventEmitter() as EventEmitter & { setTimeout: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
    req.setTimeout = vi.fn();
    req.end = vi.fn(() => {
      queueMicrotask(() => {
        const socket = new EventEmitter() as EventEmitter & { localPort: number };
        socket.localPort = ++port;
        req.emit("socket", socket); socket.emit("connect"); req.emit("finish");
        const res = new EventEmitter() as EventEmitter & { statusCode: number; setEncoding: ReturnType<typeof vi.fn> };
        res.statusCode = status; res.setEncoding = vi.fn(); callback(res);
        res.emit("data", JSON.stringify(body)); res.emit("end");
      });
    });
    return req;
  });
}
async function userSession() {
  respond({ user: { id: mocks.state.users[0].id, email: mocks.state.users[0].email }, access_token: "unit-private-token" });
  return Session.signIn(0);
}
beforeEach(() => { vi.restoreAllMocks(); mocks.request.mockReset(); mocks.save.mockClear(); mocks.state.concurrency = undefined; });
afterEach(() => vi.restoreAllMocks());

describe("concurrency secret and ownership boundaries", () => {
  it("only sends public key plus own JWT, with a separate connection for every request", async () => {
    const user = await userSession();
    respond({ ok: false, code: "invalid_state", ref: null, message: "do-not-retain-provider-text" });
    const result = await user.rpc("admin_claim_submission", { p_id: mocks.state.users[0].id });
    expect(summary(result)).toMatchObject({ status: 200, ok: false, code: "invalid_state" });
    expect(JSON.stringify(summary(result))).not.toContain("do-not-retain");
    for (const [, options] of mocks.request.mock.calls) {
      expect(options.agent).toBe(false);
      expect(options.headers.apikey).toBe("unit-public");
      expect(JSON.stringify(options)).not.toContain("unit-server");
    }
    expect(mocks.request.mock.calls[1][1].headers.Authorization).toBe("Bearer unit-private-token");
    expect(JSON.stringify(user)).not.toContain("unit-private-token");
  });
  it("refuses unowned role mutations and unknown RPCs before a request", async () => {
    const user = await userSession();
    await expect(user.rpc("admin_revoke_role", { p_user: adminId, p_role: "admin" })).rejects.toThrow("ownership mismatch");
    await expect(user.rpc("admin_grant_role_by_email", { p_email: "unrelated@example.invalid", p_role: "admin" })).rejects.toThrow("ownership mismatch");
    await expect(user.rpc("service_retention_candidates")).rejects.toThrow("allowlist");
    await expect(user.rpc("like_user", { p_target: adminId })).rejects.toThrow("ownership mismatch");
    await expect(user.rpc("get_like_state", { p_target: "00000000-0000-4000-8000-000000000999" })).rejects.toThrow("ownership mismatch");
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });
  it("does not leak unknown codes or Auth response bodies", async () => {
    expect(safeCode("P0001")).toBe("P0001");
    expect(safeCode("untrusted-private-provider-text")).toBe("unclassified_provider_error");
    respond({ access_token: "private-provider-token", message: "private-provider-password" }, 400);
    await expect(Session.signIn(0)).rejects.toThrow("Hosted concurrency sign-in failed (details suppressed)");
  });
  it("records the exact role ownership ledger before hosted mutations", async () => {
    const user = await userSession();
    registerConcurrency(user, [0]);
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ concurrency: { adminId: user.id, roleUsers: [0] } }));
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });
  it("merges a later NT-19 file's role users into the same ledger and refuses another admin", async () => {
    const user = await userSession();
    mocks.state.concurrency = { adminId: user.id, roleUsers: [0] };
    registerConcurrency(user, [0]);
    expect(mocks.state.concurrency).toEqual({ adminId: user.id, roleUsers: [0] });
    mocks.state.concurrency = { adminId, roleUsers: [0] };
    expect(() => registerConcurrency(user, [0])).toThrow("ledger mismatch");
  });
  it("revokes a verification only for a submission a run session created", async () => {
    const user = await userSession();
    const submission = "42345678-1234-4123-8123-123456789abc";
    await expect(user.rpc("admin_revoke_verification", { p_submission: submission, p_reason: "unit" })).rejects.toThrow("Submission ownership mismatch");
    expect(mocks.request).toHaveBeenCalledTimes(1);
    respond({ ok: true, code: "ok", ref: submission });
    expect((await user.rpc("submit_verification", { p_kind: "enrollment", p_document_refs: ["synthetic:sample-1"] })).ref).toBe(submission);
    respond({ ok: false, code: "invalid_state", ref: null });
    expect(summary(await user.rpc("admin_revoke_verification", { p_submission: submission, p_reason: "unit" }))).toMatchObject({ ok: false, code: "invalid_state" });
    expect(mocks.request).toHaveBeenCalledTimes(3);
  });
});

describe("admin recovery gate before cleanup", () => {
  it("refuses all cleanup when the protected admin session cannot read active staff", async () => {
    const session = await userSession();
    mocks.state.concurrency = { adminId, roleUsers: [0] };
    vi.spyOn(Session, "signIn").mockResolvedValue(session);
    const rpc = vi.spyOn(session, "rpc");
    await expect(cleanupConcurrencyRoles()).rejects.toThrow("e2e-admin admin not restored");
    expect(rpc).not.toHaveBeenCalled();
  });
  it("verifies protected admin before removing only run-granted roles and verifies removal", async () => {
    const session = await userSession();
    mocks.state.concurrency = { adminId: session.id, roleUsers: [0] };
    // Use another run-owned row, leaving the authenticated protected row intact.
    const target = "32345678-1234-4123-8123-123456789abc";
    vi.spyOn(Session, "signIn").mockImplementation(async index => index === "admin" ? session : { id: target } as Session);
    const previous = mocks.state.users[0].id;
    mocks.state.users[0].id = target;
    const rows = [{ user_id: previous, roles: ["admin"], is_me: true }, { user_id: target, roles: ["reviewer", "admin"], is_me: false }];
    const rpc = vi.spyOn(session, "rpc").mockImplementation(async (name, args) => {
      if (name === "admin_revoke_role") rows[1].roles = rows[1].roles.filter(role => role !== args!.p_role);
      return { status: 200, ok: true, code: "ok", data: name === "admin_list_staff" ? rows : { ok: true } } as Result;
    });
    try {
      await cleanupConcurrencyRoles();
      const revokes = rpc.mock.calls.filter(([name]) => name === "admin_revoke_role");
      expect(revokes).toEqual([["admin_revoke_role", { p_user: target, p_role: "reviewer" }], ["admin_revoke_role", { p_user: target, p_role: "admin" }]]);
      expect(rpc.mock.calls[0][0]).toBe("admin_list_staff");
      expect(rows[1].roles).toEqual([]);
    } finally { mocks.state.users[0].id = previous; }
  });
});

it("settles both competing requests before throwing and preserves the left/right mapping", async () => {
  let finish!: (value: Result) => void;
  const pending = new Promise<Result>(resolve => { finish = resolve; });
  let returned = false;
  const work = race(() => Promise.reject(new Error("private-provider-error")), () => pending).catch(error => { returned = true; return error.message; });
  await Promise.resolve(); await Promise.resolve();
  expect(returned).toBe(false);
  const base = { ok: true, status: 200, code: "ok", data: null, ref: null, startedAt: 10, sentAt: 20, finishedAt: 40 };
  finish({ ...base, port: 1001 });
  expect(await work).toBe("Concurrency request failed; both requests settled (details suppressed)");
  const result = await race(async () => ({ ...base, port: 1001 }), async () => ({ ...base, port: 1002, code: "invalid_state", ok: false }), true);
  expect(result.concurrent).toBe(true);
  expect(result.left.ok).toBe(true); expect(result.right.ok).toBe(false);
  const sameSocket = await race(async () => ({ ...base, port: 1001 }), async () => ({ ...base, port: 1001 }));
  expect(sameSocket.concurrent).toBe(false);
});
