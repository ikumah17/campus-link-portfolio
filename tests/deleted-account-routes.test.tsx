import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ACCOUNT-002: a deleted account keeps its Auth user until retention. Every signed-in page must answer it
// with its fixed unavailable view, read nothing but my_account (and the public affiliation master), and
// never redirect it into the app. A new page.tsx fails the inventory below until it is classified here.
const m = vi.hoisted(() => ({ create: vi.fn(), calls: [] as string[], aal: "aal2", account: {} as Record<string, unknown> }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/backend", () => ({ backendMode: () => "supabase" }));
vi.mock("@/lib/supabase/server", () => ({ createServerSupabase: m.create }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => { throw new Error(`REDIRECT:${path}`); },
  notFound: () => { throw new Error("NOT_FOUND"); },
  permanentRedirect: (path: string) => { throw new Error(`PERMANENT_REDIRECT:${path}`); },
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/", useSearchParams: () => new URLSearchParams(),
}));

const me = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", other = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
// my_account for a deleted account before the retention sweep. Before order 18 the profile still read as completed;
// from order 18 it reads only its id and 'deleted', with every flag false (ACCOUNT-004).
const deletedRows = {
  "order 17": { user_id: me, has_profile: true, account_status: "deleted", profile_completed: true, age_verified: true, adult: true,
    affiliation_status: "confirmed", affiliation_confirmed: true, has_active_photo: true, eligible: false, birth_date: "2000-01-01" },
  "order 18": { user_id: me, has_profile: true, account_status: "deleted", profile_completed: false, age_verified: false, adult: false,
    affiliation_status: null, affiliation_confirmed: false, has_active_photo: false, eligible: false, birth_date: null },
};
const leak = { id: "LEAK", name: "LEAK", school_id: "LEAK", department_id: "LEAK", display_name: "LEAK" };
const masterTables = ["from:schools", "from:departments", "from:classes"];
function query(table: string): unknown {
  m.calls.push(`from:${table}`);
  const result = Promise.resolve({ data: [leak], error: null, status: 200 });
  const chain: Record<string, unknown> = { then: result.then.bind(result) };
  for (const method of ["select", "eq", "order", "limit", "in", "single", "maybeSingle"]) chain[method] = () => chain;
  return chain;
}
const client = {
  rpc: async (name: string) => {
    m.calls.push(`rpc:${name}`);
    return name === "my_account" ? { data: [m.account], error: null } : { data: [leak], error: null };
  },
  from: query,
  auth: {
    getClaims: async () => ({ data: { claims: { sub: me, aal: m.aal } }, error: null }),
    getUser: async () => ({ data: { user: { id: me, is_anonymous: false, email: "deleted@example.invalid" } }, error: null }),
    mfa: { listFactors: async () => { m.calls.push("auth:listFactors"); return { data: { all: [] }, error: null }; } },
  },
};

type Props = Record<string, unknown>;
const empty = { searchParams: Promise.resolve({}) };
const pages: Record<string, { kind: "user" | "admin" | "public" | "confirm" | "moved"; load: () => Promise<{ default: (props: never) => unknown }>; props?: Props; aal?: string }> = {
  "/": { kind: "user", load: () => import("@/app/page") },
  "/mypage": { kind: "user", load: () => import("@/app/mypage/page") },
  "/onboarding": { kind: "user", load: () => import("@/app/onboarding/page") },
  "/onboarding?edit=1": { kind: "user", load: () => import("@/app/onboarding/page"), props: { searchParams: Promise.resolve({ edit: "1" }) } },
  "/search": { kind: "user", load: () => import("@/app/search/page") },
  "/profiles/[id]": { kind: "user", load: () => import("@/app/profiles/[id]/page"), props: { params: Promise.resolve({ id: other }), searchParams: Promise.resolve({}) } },
  "/likes": { kind: "user", load: () => import("@/app/likes/page") },
  "/mypage/profile": { kind: "user", load: () => import("@/app/mypage/profile/page") },
  // The old request page only forwards to /likes (order 34), which applies the checks above.
  "/requests": { kind: "moved", load: () => import("@/app/requests/page") },
  "/talk": { kind: "user", load: () => import("@/app/talk/page") },
  "/talk/[id]": { kind: "user", load: () => import("@/app/talk/[id]/page"), props: { params: Promise.resolve({ id: other }), searchParams: Promise.resolve({}) } },
  "/verification": { kind: "user", load: () => import("@/app/verification/page") },
  "/settings/account": { kind: "user", load: () => import("@/app/settings/account/page") },
  "/settings/privacy": { kind: "user", load: () => import("@/app/settings/privacy/page") },
  "/settings/blocks": { kind: "user", load: () => import("@/app/settings/blocks/page") },
  "/admin": { kind: "admin", load: () => import("@/app/admin/page") },
  "/admin/verifications": { kind: "admin", load: () => import("@/app/admin/verifications/page") },
  "/admin/verifications/[id]": { kind: "admin", load: () => import("@/app/admin/verifications/[id]/page"), props: { params: Promise.resolve({ id: other }) } },
  "/admin/reports": { kind: "admin", load: () => import("@/app/admin/reports/page") },
  "/admin/reports/[id]": { kind: "admin", load: () => import("@/app/admin/reports/[id]/page"), props: { params: Promise.resolve({ id: other }) } },
  "/admin/affiliations": { kind: "admin", load: () => import("@/app/admin/affiliations/page") },
  "/admin/staff": { kind: "admin", load: () => import("@/app/admin/staff/page") },
  "/admin/accounts": { kind: "admin", load: () => import("@/app/admin/accounts/page") },
  "/admin/mfa": { kind: "admin", load: () => import("@/app/admin/mfa/page"), aal: "aal1" },
  // No account data: the auth forms, the legal drafts, the welcome screen and the post-deletion notice.
  "/welcome": { kind: "public", load: () => import("@/app/welcome/page") },
  "/login": { kind: "public", load: () => import("@/app/login/page") },
  "/signup": { kind: "public", load: () => import("@/app/signup/page") },
  "/terms": { kind: "public", load: () => import("@/app/terms/page") },
  "/privacy": { kind: "public", load: () => import("@/app/privacy/page") },
  "/settings/account/deleted": { kind: "public", load: () => import("@/app/settings/account/deleted/page") },
  // Public in the proxy, but shows the signed-in address (SEC-005): a deleted account is sent to /login with nothing shown.
  "/auth/confirmed": { kind: "confirm", load: () => import("@/app/auth/confirmed/page"), props: { searchParams: Promise.resolve({ next: "/mypage" }) } },
};

beforeEach(() => { m.calls.length = 0; m.aal = "aal2"; m.account = deletedRows["order 17"]; m.create.mockResolvedValue(client); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("deleted account across every page", () => {
  it("classifies every src/app page.tsx", () => {
    const root = join(process.cwd(), "src", "app");
    const found = (readdirSync(root, { recursive: true }) as string[])
      .filter((file) => file.endsWith(`${sep}page.tsx`) || file === "page.tsx")
      .map((file) => "/" + relative(".", file).split(sep).slice(0, -1).join("/"))
      .map((path) => path === "/" ? "/" : path.replace(/\/$/, ""));
    const listed = new Set(Object.keys(pages).map((path) => path.replace(/\?.*$/, "")));
    expect([...new Set(found)].sort()).toEqual([...listed].sort());
  });

  it("/requests forwards to /likes without reading the account", async () => {
    const Page = (await pages["/requests"].load()).default as (props: Props) => unknown;
    expect(() => Page(empty)).toThrow("PERMANENT_REDIRECT:/likes");
    expect(m.calls).toEqual([]);
  });

  const signedIn = Object.entries(pages).filter(([, page]) => page.kind === "user" || page.kind === "admin");
  it.each(Object.keys(deletedRows).flatMap((row) => signedIn.map(([path, page]) => [path, row, page] as const)))("%s shows only its fixed unavailable view (%s row)", async (_path, row, page) => {
    m.account = deletedRows[row as keyof typeof deletedRows];
    if (page.aal) m.aal = page.aal;
    const Page = (await page.load()).default as (props: Props) => unknown;
    const element = await Page(page.props ?? empty);
    const { container } = render(element as React.ReactElement);
    expect(screen.getByRole("alert")).toHaveTextContent(/^現在(表示|保存)?(でき|ご利用いただけ)ません。時間をおいて再度お試しください。$/);
    expect(container).not.toHaveTextContent("LEAK");
    expect(container.querySelector("form")).toBeNull();
    expect(m.calls.filter((call) => call !== "rpc:my_account" && !masterTables.includes(call))).toEqual([]);
    expect(m.calls).toContain("rpc:my_account");
  });

  it.each(Object.keys(deletedRows).flatMap((row) => Object.entries(pages).filter(([, page]) => page.kind === "confirm").map(([path, page]) => [path, row, page] as const)))("%s sends a deleted account to /login (%s row)", async (_path, row, page) => {
    m.account = deletedRows[row as keyof typeof deletedRows];
    const Page = (await page.load()).default as (props: Props) => unknown;
    await expect(Page(page.props ?? empty)).rejects.toThrow(/^REDIRECT:\/login$/);
    expect(m.calls).toEqual(["rpc:my_account"]);
  });

  it.each(Object.entries(pages).filter(([, page]) => page.kind === "public"))("%s reads no account data", async (_path, page) => {
    const Page = (await page.load()).default as (props: Props) => unknown;
    render(await Page(page.props ?? empty) as React.ReactElement);
    expect(m.calls).toEqual([]);
  });
});
