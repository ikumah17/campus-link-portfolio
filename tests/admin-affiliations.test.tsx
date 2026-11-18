import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { AdminProvider } from "@/lib/admin-demo";
import { AdminAffiliations } from "@/components/admin-affiliations";

describe("admin affiliation tree", () => {
  it("adds, renames and deactivates a class, preserving focus and rows", async () => {
    const user = userEvent.setup({ delay: null }); render(<AdminProvider><AdminAffiliations /></AdminProvider>);
    const dept = screen.getByRole("region", { name: "デモ学科A1（架空）" });
    const add = within(dept).getByRole("button", { name: "クラスを追加" }); await user.click(add);
    const name = screen.getByRole("textbox", { name: "名前" }); await waitFor(() => expect(name).toHaveFocus());
    await user.type(name, "新しい架空クラス");
    const year = screen.getByRole("spinbutton", { name: "年度（任意）" }); await user.clear(year); await user.type(year, "2027");
    await user.click(screen.getByRole("button", { name: "保存する" }));
    await waitFor(() => expect(add).toHaveFocus());
    let row = screen.getByRole("region", { name: "新しい架空クラス" }); expect(row).toHaveTextContent("2027");
    await user.click(within(row).getByRole("button", { name: "編集" }));
    await user.clear(screen.getByRole("textbox", { name: "名前" })); await user.type(screen.getByRole("textbox", { name: "名前" }), "変更した架空クラス");
    await user.click(screen.getByRole("button", { name: "保存する" }));
    row = screen.getByRole("region", { name: "変更した架空クラス" });
    await user.click(within(row).getByRole("switch"));
    expect(row).toHaveTextContent("無効"); expect(within(row).getByRole("switch")).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByRole("button", { name: /削除/ })).not.toBeInTheDocument();
  });
  it("validates names, duplicates and restores focus on Escape", async () => {
    const user = userEvent.setup({ delay: null }); render(<AdminProvider><AdminAffiliations /></AdminProvider>);
    const add = screen.getByRole("button", { name: "学校を追加" }); await user.click(add);
    await user.click(screen.getByRole("button", { name: "保存する" }));
    expect(screen.getByRole("alert")).toHaveTextContent("1〜80文字");
    const name = screen.getByRole("textbox", { name: "名前" }); expect(name).toHaveFocus();
    await user.paste("a".repeat(81)); await user.click(screen.getByRole("button", { name: "保存する" }));
    expect(name).toHaveFocus(); await user.clear(name); await user.paste("デモ学校A（架空）");
    await user.click(screen.getByRole("button", { name: "保存する" })); expect(screen.getByRole("alert")).toHaveTextContent("同名");
    await user.keyboard("{Escape}"); await waitFor(() => expect(add).toHaveFocus());
    expect(screen.queryByRole("form")).not.toBeInTheDocument();
  });
  it("adds a school and a department, and edits sort order", async () => {
    const user = userEvent.setup({ delay: null }); render(<AdminProvider><AdminAffiliations /></AdminProvider>);
    await user.click(screen.getByRole("button", { name: "学校を追加" }));
    await user.type(screen.getByRole("textbox", { name: "名前" }), "追加学校（架空）");
    await user.clear(screen.getByRole("spinbutton")); await user.type(screen.getByRole("spinbutton"), "-1");
    await user.click(screen.getByRole("button", { name: "保存する" }));
    const school = screen.getByRole("region", { name: "追加学校（架空）" }); expect(school).toHaveTextContent("表示順：-1");
    await user.click(within(school).getByRole("button", { name: "学科を追加" }));
    await user.type(screen.getByRole("textbox", { name: "名前" }), "追加学科（架空）");
    await user.click(screen.getByRole("button", { name: "保存する" }));
    expect(screen.getByRole("region", { name: "追加学科（架空）" })).toBeInTheDocument();
  });
});
