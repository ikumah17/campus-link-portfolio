import { test, expect } from "@playwright/test";
import { readState, saveState, evidence } from "./state";
import { discover, loadedPhoto, userPage } from "./ui";

test("both verified users discover each other and load detail photos", async ({ browser }) => {
  const profiles: string[] = [];
  for (let i = 0; i < 2; i++) {
    const page = await userPage(browser, i);
    try {
      const other = readState().users[1 - i];
      await (await discover(page, other.name)).click();
      await expect(page.getByRole("heading", { level: 1 })).toContainText(other.name);
      await loadedPhoto(page, `${other.name}の写真 1`);
      profiles[1 - i] = new URL(page.url()).pathname;
    } finally { await page.context().close(); }
  }
  saveState({ ...readState(), profiles });
  evidence("discover", { status: "pass", detailPhotoLoadedBothWays: true });
});
