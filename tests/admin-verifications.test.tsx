import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { AdminVerifications } from "@/components/admin-verifications";

const list = () => within(screen.getByRole("tabpanel"));
const select = async (user: ReturnType<typeof userEvent.setup>) => user.click(list().getByRole("button"));
describe("fictional reviewer demo", () => {
  it("filters all states without exposing birth dates in the list and supports arrow navigation", async () => {
    const user = userEvent.setup(); render(<AdminVerifications />);
    expect(screen.getByText(/実際のアクセス制御はありません/)).toBeInTheDocument();
    for (const name of ["提出済み", "審査中", "承認", "却下"]) {
      await user.click(screen.getByRole("tab", { name })); expect(list().getByRole("button")).toHaveTextContent(name);
      expect(screen.getByRole("tabpanel")).not.toHaveTextContent("2000-02-29");
    }
    screen.getByRole("tab", { name: "却下" }).focus(); await user.keyboard("{ArrowRight}"); expect(screen.getByRole("tab", { name: "提出済み" })).toHaveFocus();
    await user.keyboard("{End}"); expect(screen.getByRole("tab", { name: "却下" })).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Home}{ArrowLeft}"); expect(screen.getByRole("tab", { name: "却下" })).toHaveFocus();
  });
  it("claims, releases, reclaims and approves with status and focus", async () => {
    const user = userEvent.setup(); render(<AdminVerifications />); await select(user);
    await waitFor(() => expect(screen.getByRole("heading", { name: "提出の詳細" })).toHaveFocus());
    expect(screen.getByText("2000-02-29")).toBeInTheDocument(); expect(screen.getByRole("tabpanel")).not.toHaveTextContent("2000-02-29");
    await user.click(screen.getByRole("button", { name: "担当する" })); expect(screen.getByRole("status")).toHaveTextContent("担当しました");
    expect(list().queryByRole("button")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "担当を外す" })); expect(screen.getByRole("status")).toHaveTextContent("担当を外しました");
    await user.click(screen.getByRole("button", { name: "担当する" })); await user.click(screen.getByRole("button", { name: "承認" }));
    expect(screen.getByRole("status")).toHaveTextContent("承認しました"); expect(screen.queryByRole("button", { name: "承認" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "承認" })); expect(list().getAllByRole("button")).toHaveLength(2);
  });
  it("requires a reason, rejects and clears errors when selecting another item", async () => {
    const user = userEvent.setup(); render(<AdminVerifications />); await user.click(screen.getByRole("tab", { name: "審査中" })); await select(user);
    await user.click(screen.getByRole("button", { name: "却下" }));
    const reason = screen.getByLabelText("却下理由（1〜200文字）"); expect(reason).toHaveFocus(); expect(reason).toHaveAttribute("aria-invalid", "true");
    await user.type(reason, "架空の理由"); await user.click(screen.getByRole("button", { name: "却下" }));
    expect(screen.getByRole("status")).toHaveTextContent("却下しました"); expect(screen.getByText("架空の理由")).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "却下" })); expect(list().getAllByRole("button")).toHaveLength(2);
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument(); expect(document.querySelector('input[type="file"]')).toBeNull();
  });
});
