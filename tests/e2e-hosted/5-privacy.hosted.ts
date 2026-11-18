import { test, expect } from "@playwright/test";
import { readState, evidence } from "./state";
import { userPage, discover } from "./ui";

test("B hides A's class and restores discover visibility", async ({ browser }) => {
  const a = await userPage(browser, 0);
  const b = await userPage(browser, 1, "/settings/privacy");
  try {
    await discover(a, readState().users[1].name);
    await b.getByRole("button", { name: /非表示対象を管理/ }).click();
    const label = "デモ学校A（架空） / デモ学科A1（架空） / デモクラスA1-1（架空）";
    await b.getByRole("button", { name: `${label}を追加`, exact: true }).click();
    await b.getByRole("button", { name: "保存する" }).click();
    await expect(b.getByRole("status")).toHaveText("保存しました。");
    await discover(a, readState().users[1].name, false);
    await b.getByRole("button", { name: `${label}を解除`, exact: true }).click();
    await b.getByRole("button", { name: "保存する" }).click();
    await expect(b.getByRole("status")).toHaveText("保存しました。");
    await discover(a, readState().users[1].name);
    evidence("privacy", { status: "pass" });
  } finally { await a.context().close(); await b.context().close(); }
});
