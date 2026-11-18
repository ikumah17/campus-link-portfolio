// MOBILE-002: a fake supabase-js client for the data and screen tests. rpc() answers from a handler; from() returns a
// thenable query that records its calls and answers from the table map.
export type RpcAnswer = { data: unknown; error: { code?: string; message?: string; status?: number } | null; status?: number };
export type TableAnswer = { data: unknown; error: { code?: string } | null; status?: number };

export const ok = (data: unknown): RpcAnswer => ({ data, error: null, status: 200 });
export const refusal = (code: string): RpcAnswer => ({ data: { ok: false, code }, error: null, status: 200 });
export const done = (): RpcAnswer => ({ data: { ok: true, code: "ok", ref: null }, error: null, status: 200 });
export const raised = (message: "validation" | "forbidden"): RpcAnswer => ({ data: null, error: { code: "P0001", message }, status: 400 });

export function fakeSupabase(rpcHandler: (name: string, args: Record<string, unknown>) => RpcAnswer,
  tables: Record<string, TableAnswer | (() => TableAnswer)> = {}) {
  const queries: { table: string; calls: [string, ...unknown[]][] }[] = [];
  const rpc = jest.fn(async (name: string, args: Record<string, unknown> = {}) => rpcHandler(name, args));
  const from = jest.fn((table: string) => {
    const record = { table, calls: [] as [string, ...unknown[]][] };
    queries.push(record);
    const query = {
      select: (...args: unknown[]) => { record.calls.push(["select", ...args]); return query; },
      eq: (...args: unknown[]) => { record.calls.push(["eq", ...args]); return query; },
      order: (...args: unknown[]) => { record.calls.push(["order", ...args]); return query; },
      limit: (...args: unknown[]) => { record.calls.push(["limit", ...args]); return query; },
      then: (resolve: (value: TableAnswer) => unknown, reject?: (reason: unknown) => unknown) => {
        const answer = tables[table];
        const value = typeof answer === "function" ? answer() : answer ?? { data: null, error: { code: "missing" } };
        return Promise.resolve(value).then(resolve, reject);
      },
    };
    return query;
  });
  return { rpc, from, queries };
}

export const USER = "11111111-1111-4111-8111-111111111111";
export const SCHOOL = "22222222-2222-4222-8222-222222222222";
export const DEPT = "33333333-3333-4333-8333-333333333333";
export const CLASS = "44444444-4444-4444-8444-444444444444";
export const PHOTO_A = "55555555-5555-4555-8555-555555555555";
export const PHOTO_B = "66666666-6666-4666-8666-666666666666";
export const SUBMISSION = "77777777-7777-4777-8777-777777777777";

export const masterTables = {
  schools: { data: [{ id: SCHOOL, name: "架空大学" }], error: null },
  departments: { data: [{ id: DEPT, name: "架空学科", school_id: SCHOOL }], error: null },
  classes: { data: [{ id: CLASS, name: "Aクラス", department_id: DEPT }], error: null },
};

export function accountRow(overrides: Record<string, unknown> = {}) {
  return {
    user_id: USER, has_profile: true, account_status: "active", profile_completed: true, age_verified: false, adult: true,
    affiliation_status: "unconfirmed", affiliation_confirmed: false, has_active_photo: true, eligible: false,
    birth_date: "2000-04-01", ...overrides,
  };
}

// MOBILE-003: a counterpart and a conversation.
export const TARGET = "88888888-8888-4888-8888-888888888888";
export const CONV = "99999999-9999-4999-8999-999999999999";
export const CONN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

export function profileRow(overrides: Record<string, unknown> = {}) {
  return {
    user_id: TARGET, display_name: "架空の相手", age: 21, gender: "female", school_name: "架空大学", department_name: null, class_name: null,
    bio: "よろしくお願いします。", purposes: ["friends", "hobby"], hobbies: ["読書"], photo_ids: [PHOTO_A], ...overrides,
  };
}
export function conversationRow(overrides: Record<string, unknown> = {}) {
  return {
    conversation_id: CONV, connection_id: CONN, counterpart_id: TARGET, counterpart_name: "架空の相手", counterpart_photo_id: PHOTO_A, unread: true,
    last_message_id: 2, last_message_body: "こんにちは", last_message_at: "2026-11-17T03:00:00Z", last_message_mine: false, ...overrides,
  };
}
export const messageRow = (id: number, sender: string, overrides: Record<string, unknown> = {}) =>
  ({ id, sender_id: sender, body: `本文${id}`, created_at: "2026-11-17T03:00:00Z", hidden: false, ...overrides });

// MOBILE-LIKES-001: a list_my_likes row and a get_like_state row.
export const likeRow = (overrides: Record<string, unknown> = {}, profile: Record<string, unknown> = {}) =>
  ({ counterpart_id: TARGET, liked_at: "2026-11-17T03:00:00Z", counterpart: profileRow(profile), ...overrides });
export const likeStateRow = (overrides: Record<string, unknown> = {}) => ({ i_liked: false, liked_me: false, conversation_id: null, ...overrides });
