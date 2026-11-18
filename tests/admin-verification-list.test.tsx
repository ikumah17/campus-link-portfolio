import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SubmissionRow } from "@/server/admin-verifications";
const m = vi.hoisted(() => ({ claim: vi.fn(), revoke: vi.fn(), push: vi.fn(), refresh: vi.fn(), links: [] as { href: string; prefetch?: boolean }[] }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: m.push, refresh: m.refresh }) }));
vi.mock("next/link", () => ({ default: ({ href, prefetch, children, ...props }: React.ComponentProps<"a"> & { prefetch?: boolean }) => { m.links.push({ href: href!, prefetch }); return <a href={href} {...props}>{children}</a>; } }));
vi.mock("@/server/admin-verification-actions", () => ({ claimSubmission: m.claim, revokeVerification: m.revoke }));
import { AdminVerificationList } from "@/components/admin-verification-list";
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", me = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const row: SubmissionRow = { id, kind: "age", status: "submitted", assignedToMe: false, version: 0, created_at: "2026-11-05T15:30:00Z" };
let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => { vi.resetAllMocks(); m.links.length = 0; fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network forbidden")); m.claim.mockResolvedValue({ status: "ok" }); m.revoke.mockResolvedValue({ status: "ok" }); });
afterEach(() => { expect(fetchSpy).not.toHaveBeenCalled(); vi.restoreAllMocks(); });
const view = (r: SubmissionRow = row) => render(<AdminVerificationList submissions={[r]} status={r.status} />);
it("renders safe fields, Tokyo date and non-prefetching filters", () => {
  const { container } = view();
  expect(container).toHaveTextContent("年齢確認"); expect(container).toHaveTextContent("2026/11/06 00:30"); expect(container).not.toHaveTextContent(/デモ|birth_date/);
  expect(container).not.toHaveTextContent("cccccccc-cccc-4ccc-8ccc-cccccccccccc"); expect(container).not.toHaveTextContent(me);
  expect(screen.getByRole("link", { name: "提出済み" })).toHaveAttribute("aria-current", "page");
  expect(m.links.every(l => l.prefetch === false)).toBe(true);
});
it("claims once and navigates only after success", async () => {
  let resolve!: (value: { status: string }) => void;
  m.claim.mockReturnValue(new Promise(r => { resolve = r; })); view();
  const button = screen.getByRole("button", { name: "担当する" }); fireEvent.click(button); fireEvent.click(button);
  expect(button).toBeDisabled(); expect(screen.getByRole("region", { name: "提出一覧" })).toHaveAttribute("aria-busy", "true");
  expect(m.claim).toHaveBeenCalledExactlyOnceWith(id); expect(m.push).not.toHaveBeenCalled();
  resolve({ status: "ok" }); await waitFor(() => expect(m.push).toHaveBeenCalledWith(`/admin/verifications/${id}`));
});
it("offers opening only the current reviewer's submission", () => {
  const { rerender } = view({ ...row, status: "in_review", assignedToMe: true });
  expect(screen.getByRole("link", { name: "開く" })).toHaveAttribute("href", `/admin/verifications/${id}`);
  expect(m.links.filter(l => l.href.startsWith("/admin/verifications")).every(l => l.prefetch === false)).toBe(true);
  rerender(<AdminVerificationList submissions={[{ ...row, status: "in_review", assignedToMe: false }]} status="in_review" />);
  expect(screen.queryByRole("link", { name: "開く" })).not.toBeInTheDocument(); expect(screen.getByText("他の担当者が審査中")).toBeInTheDocument();
});
it("requires a revocation reason and refreshes on success", async () => {
  view({ ...row, status: "approved", kind: "enrollment" }); fireEvent.click(screen.getByRole("button", { name: "確認を取り消す" }));
  expect(screen.getByRole("button", { name: "取り消す" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("取消理由"), { target: { value: "no_longer_enrolled" } });
  fireEvent.click(screen.getByRole("button", { name: "取り消す" }));
  await waitFor(() => expect(m.refresh).toHaveBeenCalledOnce());
  expect(m.revoke).toHaveBeenCalledExactlyOnceWith({ submissionId: row.id, reason: "no_longer_enrolled" });
});
it("shows the existing stale-state message when an older approved row cannot be revoked", async () => {
  m.revoke.mockResolvedValue({ status: "invalid_state" }); view({ ...row, status: "approved" });
  fireEvent.click(screen.getByRole("button", { name: "確認を取り消す" }));
  fireEvent.change(screen.getByLabelText("取消理由"), { target: { value: "document_invalid" } });
  fireEvent.click(screen.getByRole("button", { name: "取り消す" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("状態が変わりました。一覧から開き直してください。");
  expect(m.revoke).toHaveBeenCalledExactlyOnceWith({ submissionId: row.id, reason: "document_invalid" });
  expect(m.refresh).not.toHaveBeenCalled(); expect(m.push).not.toHaveBeenCalled();
});
it.each(["rejected", "revoked"] as const)("%s has no mutation control", status => { view({ ...row, status }); expect(screen.queryByRole("button")).not.toBeInTheDocument(); });
it.each([
  ["invalid", "入力内容を確認してください。"], ["invalid_state", "状態が変わりました。一覧から開き直してください。"], ["forbidden", "この操作はできません。"], ["unauthenticated", "ログインの有効期限が切れました。"], ["unavailable", "現在保存できません。時間をおいて再度お試しください。"],
])("shows fixed %s errors", async (status, message) => {
  m.claim.mockResolvedValue({ status }); view(); fireEvent.click(screen.getByRole("button", { name: "担当する" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(message); expect(m.push).not.toHaveBeenCalled();
  if (status === "unauthenticated") expect(screen.getByRole("link", { name: "ログイン" })).toHaveAttribute("href", "/login?next=/admin/verifications");
  if (status === "invalid_state") expect(screen.getByRole("link", { name: "一覧へ戻る" })).toHaveAttribute("href", "/admin/verifications");
});
it("contains unexpected failures", async () => { m.claim.mockRejectedValue(new Error("private")); view(); fireEvent.click(screen.getByRole("button", { name: "担当する" })); expect(await screen.findByRole("alert")).not.toHaveTextContent("private"); });
it("shows empty state and a fixed completion notice", () => {
  render(<AdminVerificationList submissions={[]} status="submitted" notice="decided" />);
  expect(screen.getByText("この状態の提出はありません。")).toBeInTheDocument(); expect(screen.getByRole("status")).toHaveTextContent("審査結果を保存しました。");
});

it("exposes UUIDs only in submission links, with no user ids in HTML attributes", () => {
  const { container } = view({ ...row, status: "in_review", assignedToMe: true });
  expect(container.innerHTML).not.toContain(me);
  expect(container.innerHTML).not.toContain("cccccccc-cccc-4ccc-8ccc-cccccccccccc");
  expect(container.innerHTML.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g)).toEqual([id]);
  expect(container.querySelector(`a[href="/admin/verifications/${id}"]`)).not.toBeNull();
});
