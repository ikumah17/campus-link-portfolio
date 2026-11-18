import { test, expect } from "@playwright/test";
import { readState, saveState, evidence } from "./state";
import { adminPage, userPage, submissionIds } from "./ui";

test("synthetic age and enrollment submissions are approved at aal2", async ({ browser }) => {
  const ids: string[] = [];
  for (let i = 0; i < 2; i++) {
    const page = await userPage(browser, i, "/verification");
    try {
      for (const title of ["年齢確認", "在学確認"]) {
        const section = page.getByRole("region", { name: title, exact: true });
        await section.getByRole("button", { name: "架空のサンプル資料1", exact: true }).click();
        await section.getByRole("button", { name: "提出", exact: true }).click();
        await expect(section.getByText("提出済み", { exact: true })).toBeVisible();
      }
      await page.reload();
      // Read only this user's serialized screen projection; never select arbitrary
      // admin queue entries, which could belong to somebody outside this run.
      const ownIds = await submissionIds(page);
      expect(new Set(ownIds).size).toBe(2);
      ids.push(...new Set(ownIds));
    } finally { await page.context().close(); }
  }
  saveState({ ...readState(), submissions: ids });
  const admin = await adminPage(browser);
  try {
    for (const id of ids) {
      await admin.goto("/admin/verifications");
      // The claim action carries the run-owned ID in its serialized React props.
      // Match the queue's order to those exact props; no unowned row is claimed.
      const queueIds = await submissionIds(admin);
      const index = queueIds.indexOf(id);
      expect(index, "run-owned submission is in the rendered review queue").toBeGreaterThanOrEqual(0);
      await admin.getByRole("region", { name: "提出一覧" }).getByRole("listitem").nth(index).getByRole("button", { name: "担当する" }).click();
      await expect(admin).toHaveURL(new RegExp(`/admin/verifications/${id}$`));
      await expect(admin.getByAltText("提出資料 1")).toBeVisible();
      await expect.poll(() => admin.getByAltText("提出資料 1").evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
      await admin.getByRole("button", { name: "承認", exact: true }).click();
      await expect(admin.getByRole("status")).toHaveText("審査結果を保存しました。");
    }
  } finally { await admin.context().close(); }
  for (let i = 0; i < 2; i++) {
    const page = await userPage(browser, i);
    try { await expect(page.getByRole("region", { name: "確認状況" }).getByText("確認済み", { exact: true })).toHaveCount(2); }
    finally { await page.context().close(); }
  }
  evidence("verification", { status: "pass", approvals: 4, syntheticDocumentLoaded: true });
});
