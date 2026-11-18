import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SubmissionDetail } from "@/server/admin-verifications";
const m = vi.hoisted(() => ({ decide: vi.fn(), release: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: m.push }) }));
vi.mock("@/server/admin-verification-actions", () => ({ decideSubmission: m.decide, releaseSubmission: m.release }));
import { AdminVerificationDetail, defaultValidityDate } from "@/components/admin-verification-detail";
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const age: SubmissionDetail = { id, kind: "age", status: "in_review", version: 7, created_at: "2026-11-05T15:30:00Z", documentCount: 2, birth_date: "2000-01-02" };
const enrollment: SubmissionDetail = { id, kind: "enrollment", status: "in_review", version: 7, created_at: age.created_at, documentCount: 1, school_name: "School", department_name: "Department", class_name: null };
let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => { vi.resetAllMocks(); fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network forbidden")); m.decide.mockResolvedValue({ status: "ok" }); m.release.mockResolvedValue({ status: "ok" }); });
afterEach(() => { expect(fetchSpy).not.toHaveBeenCalled(); vi.useRealTimers(); vi.restoreAllMocks(); });
it("shows age fields only and lazy audited documents", () => {
  const { container } = render(<AdminVerificationDetail submission={{ ...age, school_name: "Hidden school" } as SubmissionDetail} />);
  expect(screen.getByText("2000-01-02")).toBeInTheDocument(); expect(screen.queryByLabelText("有効期限")).not.toBeInTheDocument();
  expect(container).not.toHaveTextContent(/Hidden school|デモ/);
  expect(screen.getAllByRole("img")).toHaveLength(2);
  for (let i = 1; i <= 2; i++) { const img = screen.getByRole("img", { name: `提出資料 ${i}` }); expect(img).toHaveAttribute("src", `/admin/documents/${id}/${i}`); expect(img).toHaveAttribute("loading", "lazy"); expect(img).toHaveAttribute("width", "480"); }
});
it("never renders a birth date in enrollment and handles null names", () => {
  const { container } = render(<AdminVerificationDetail submission={{ ...enrollment, birth_date: "private birth" } as SubmissionDetail} />);
  expect(container).not.toHaveTextContent(/private birth|申告した生年月日|デモ/); expect(screen.getByText("School")).toBeInTheDocument(); expect(screen.getByText("Department")).toBeInTheDocument(); expect(screen.getByText("確認できません")).toBeInTheDocument();
});
it.each([["2026-03-30T14:59:59Z", "2026-03-31"], ["2026-03-30T15:00:00Z", "2027-03-31"], ["2026-03-31T15:00:00Z", "2027-03-31"], ["2026-12-31T15:00:00Z", "2027-03-31"]])("defaults around Tokyo boundary %s", (clock, expected) => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(clock)); expect(defaultValidityDate()).toBe(expected);
  render(<AdminVerificationDetail submission={enrollment} />); expect(screen.getByLabelText("有効期限")).toHaveValue(expected);
});
it.each([age, enrollment])("approves with exact kind and optimistic version %#", async submission => {
  render(<AdminVerificationDetail submission={submission} />);
  if (submission.kind === "enrollment") fireEvent.change(screen.getByLabelText("有効期限"), { target: { value: "2028-03-31" } });
  fireEvent.click(screen.getByRole("button", { name: "承認" }));
  await waitFor(() => expect(m.push).toHaveBeenCalledWith("/admin/verifications?notice=decided"));
  expect(m.decide).toHaveBeenCalledExactlyOnceWith({ id, kind: submission.kind, approve: true, reason: null, validUntil: submission.kind === "enrollment" ? "2028-03-31" : null, expectedVersion: 7 });
});
it("supports keyboard rejection with an allow-listed code", async () => {
  const user = userEvent.setup({ delay: null }); render(<AdminVerificationDetail submission={age} />);
  expect(screen.getByRole("button", { name: "却下" })).toBeDisabled();
  await user.selectOptions(screen.getByLabelText("却下理由"), "document_unreadable");
  screen.getByRole("button", { name: "却下" }).focus(); await user.keyboard("{Enter}");
  await waitFor(() => expect(m.push).toHaveBeenCalledWith("/admin/verifications?notice=decided"));
  expect(m.decide).toHaveBeenCalledWith({ id, kind: "age", approve: false, reason: "document_unreadable", validUntil: null, expectedVersion: 7 });
});
it("releases and returns with a fixed notice", async () => {
  render(<AdminVerificationDetail submission={age} />); fireEvent.click(screen.getByRole("button", { name: "担当を外す" }));
  await waitFor(() => expect(m.push).toHaveBeenCalledWith("/admin/verifications?notice=released")); expect(m.release).toHaveBeenCalledExactlyOnceWith(id);
});
it("disables all controls and serializes operations", async () => {
  let resolve!: (value: { status: string }) => void; m.decide.mockReturnValue(new Promise(r => { resolve = r; }));
  const { container } = render(<AdminVerificationDetail submission={enrollment} />);
  fireEvent.click(screen.getByRole("button", { name: "承認" }));
  fireEvent.click(screen.getByRole("button", { name: "担当を外す" }));
  expect(container.querySelector("fieldset")).toHaveAttribute("aria-busy", "true");
  for (const control of container.querySelectorAll("button,input,select")) expect(control).toBeDisabled();
  expect(m.decide).toHaveBeenCalledOnce(); expect(m.release).not.toHaveBeenCalled();
  resolve({ status: "ok" }); await waitFor(() => expect(m.push).toHaveBeenCalledOnce());
});
it.each([["invalid", "入力内容を確認してください。"], ["invalid_state", "状態が変わりました。一覧から開き直してください。"], ["forbidden", "この操作はできません。"], ["unauthenticated", "ログインの有効期限が切れました。"], ["unavailable", "現在保存できません。時間をおいて再度お試しください。"]])("shows %s without navigation", async (status, message) => {
  m.decide.mockResolvedValue({ status }); render(<AdminVerificationDetail submission={age} />); fireEvent.click(screen.getByRole("button", { name: "承認" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(message); expect(m.push).not.toHaveBeenCalled();
  if (status === "invalid_state") expect(screen.getByRole("link", { name: "一覧へ戻る" })).toHaveAttribute("href", "/admin/verifications");
  if (status === "unauthenticated") expect(screen.getByRole("link", { name: "ログイン" })).toHaveAttribute("href", "/login?next=/admin/verifications");
});
it("contains thrown failures and allows retry", async () => {
  m.release.mockRejectedValueOnce(new Error("private provider")); render(<AdminVerificationDetail submission={age} />); fireEvent.click(screen.getByRole("button", { name: "担当を外す" }));
  expect(await screen.findByRole("alert")).not.toHaveTextContent("private provider"); expect(screen.getByRole("button", { name: "担当を外す" })).not.toBeDisabled();
});
