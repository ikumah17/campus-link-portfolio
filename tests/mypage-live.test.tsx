import { it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
const m = vi.hoisted(() => ({ mode: "supabase", create: vi.fn(), load: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/backend", () => ({ backendMode: () => m.mode }));
vi.mock("@/lib/supabase/server", () => ({ createServerSupabase: m.create }));
vi.mock("@/server/mypage-data", () => ({ loadMyPage: m.load }));
vi.mock("next/navigation", () => ({ redirect: (s: string) => { throw Error(s); } }));
vi.mock("@/components/logout-button", () => ({ LogoutButton: () => <button>ログアウト</button>, LogoutEverywhereButton: () => <button>すべての端末からログアウト</button> }));
import Page, { generateMetadata } from "@/app/mypage/page";
import { MyPageLive } from "@/components/mypage-live";
import type { MyPageData } from "@/server/mypage-data";
const page: MyPageData = { name: "Alice", accountStatus: "active", ageVerified: true, affiliation: "confirmed", eligible: true };
const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(Error("network"));
afterEach(() => { cleanup(); expect(network).not.toHaveBeenCalled(); vi.clearAllMocks(); m.mode = "supabase"; });
it("preserves demo and titles without creating a client", async () => {
  m.mode = "demo"; render(await Page()); expect(screen.getByText("架空アカウントの設定デモ")).toBeInTheDocument();
  expect(m.create).not.toHaveBeenCalled(); expect((await generateMetadata()).title).toBe("マイページ（デモ）| Campus Link");
  m.mode = "supabase"; expect((await generateMetadata()).title).toBe("マイページ | Campus Link");
});
it.each(["ok", "incomplete", "unauthenticated", "unavailable", "throw", "client-throw"])("handles page %s", async status => {
  m.create.mockResolvedValue({}); m.load.mockResolvedValue({ status, page });
  if (status === "throw") m.load.mockRejectedValueOnce(Error("secret"));
  if (status === "client-throw") m.create.mockRejectedValueOnce(Error("secret"));
  if (status === "incomplete" || status === "unauthenticated") await expect(Page()).rejects.toThrow(status === "incomplete" ? "/onboarding" : "/login?next=%2Fmypage");
  else { render(await Page()); if (status === "ok") expect(screen.getByText("Alice")).toBeInTheDocument(); else expect(screen.getByRole("alert")).toHaveTextContent("現在表示できません。時間をおいて再度お試しください。"); }
});
it.each([["confirmed", "確認済み"], ["pending", "審査中"], ["rejected", "確認できませんでした"], ["unconfirmed", "未確認"], ["expired", "期限切れ"]] as const)("renders %s and safe links", (affiliation, label) => {
  const { container } = render(<MyPageLive page={{ ...page, affiliation, ageVerified: false, eligible: false, accountStatus: "suspended" }} />);
  expect(screen.getAllByText(label).length).toBeGreaterThan(0); expect(screen.getAllByText("未確認").length).toBeGreaterThan(0);
  expect(screen.getByText("確認状況")).toBeInTheDocument(); expect(screen.getByText("このアカウントは停止されています。")).toBeInTheDocument();
  expect(screen.getByText(/確認が済むと、探す・いいね・トークを利用できます。/)).toBeInTheDocument();
  for (const [name, href] of [["プロフィールを編集", "/mypage/profile"], ["公開範囲設定", "/settings/privacy"], ["ブロック中のユーザー", "/settings/blocks"], ["アカウント", "/settings/account"], ["在学・年齢確認", "/verification"], ["在学・年齢確認へ", "/verification"]]) expect(screen.getByRole("link", { name })).toHaveAttribute("href", href);
  expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual(["ログアウト", "すべての端末からログアウト"]); expect(container.textContent).not.toMatch(/デモ|架空/); expect(container.querySelector('a[href="/admin"]')).toBeNull();
});
it("omits ineligible and suspension lines for a verified active user", () => {
  render(<MyPageLive page={page} />); expect(screen.getAllByText("確認済み")).toHaveLength(2);
  expect(screen.queryByText(/確認が済むと/)).toBeNull(); expect(screen.queryByText(/停止されています/)).toBeNull();
});

it("links to legal drafts", () => {
 render(<MyPageLive page={page} />);
 expect(screen.getByRole("link", { name: "利用規約" })).toHaveAttribute("href", "/terms");
 expect(screen.getByRole("link", { name: "プライバシーポリシー" })).toHaveAttribute("href", "/privacy");
});
it("a paused account links to resuming instead of the verification hint", () => {
  render(<MyPageLive page={{ ...page, accountStatus: "deactivated", eligible: false }} />);
  expect(screen.getByText(/アカウントは休止中です。/)).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "再開する" })).toHaveAttribute("href", "/settings/account");
  expect(screen.queryByText(/確認が済むと/)).toBeNull(); expect(screen.queryByText(/停止されています/)).toBeNull();
});
