import { test, expect, type Page } from "@playwright/test";
import sharp from "sharp";
import { readState, evidence } from "./state";
import { loadedPhoto, photoPng, userPage } from "./ui";

// UI-014: a generated 3000×2000 PNG (no real photo) is shrunk in the browser to a WebP under a neutral name,
// accepted, and delivered at most 1600 px on its longest side. It is then removed, so later groups still see one photo.
async function largePhoto(page: Page) {
  const buffer = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: { r: 130, g: 140, b: 150 } } }).png().toBuffer();
  // Playwright does not expose a Blob multipart body, so record the uploaded part in the page itself.
  await page.evaluate(() => {
    const original = window.fetch;
    window.fetch = (input, init) => {
      const part = init?.body instanceof FormData ? init.body.get("photo") : null;
      if (part instanceof File) Object.assign(window, { uploadedPart: { name: part.name, type: part.type, size: part.size } });
      return original(input, init);
    };
  });
  const uploaded = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/photos" && response.request().method() === "POST");
  await page.getByLabel("写真を追加", { exact: true }).setInputFiles({ name: "fictional-large.png", mimeType: "image/png", buffer });
  const upload = await uploaded;
  expect(upload.status()).toBe(200);
  expect(await upload.json()).toEqual({ status: "ok" });
  const part = await page.evaluate(() => (window as unknown as { uploadedPart?: { name: string; type: string; size: number } }).uploadedPart);
  expect(part && { name: part.name, type: part.type }).toEqual({ name: "photo.webp", type: "image/webp" });
  expect(part!.size).toBeLessThan(buffer.length);
  await loadedPhoto(page, "登録した写真 2");
  const size = await page.getByAltText("登録した写真 2", { exact: true }).evaluate((element: HTMLImageElement) => [element.naturalWidth, element.naturalHeight]);
  expect(Math.max(...size)).toBeLessThanOrEqual(1600);
  expect(size).toEqual([1600, 1067]);
  const second = page.getByRole("list", { name: "登録した写真" }).getByRole("listitem").nth(1);
  await second.getByRole("button", { name: "削除", exact: true }).click();
  await expect(page.getByAltText("登録した写真 2", { exact: true })).toHaveCount(0);
  await expect(page.getByAltText("登録した写真 1", { exact: true })).toBeVisible();
  return { width: size[0], height: size[1], originalBytes: buffer.length, uploadBytes: part!.size };
}

test("fresh fictional users complete onboarding and load their private photos", async ({ browser }) => {
  let large: Awaited<ReturnType<typeof largePhoto>> | undefined;
  for (let i = 0; i < 2; i++) {
    const page = await userPage(browser, i, "/onboarding");
    try {
      await page.getByLabel("表示名", { exact: true }).fill(readState().users[i].name);
      await page.getByRole("radio", { name: "その他", exact: true }).check();
      await page.getByLabel("生年月日", { exact: true }).fill("2000-01-02");
      await page.getByLabel("18歳以上です", { exact: true }).check();
      await page.getByRole("button", { name: "次へ", exact: true }).click();
      await page.getByLabel("学校", { exact: true }).selectOption("00000000-0000-4000-8000-00000000a001");
      await page.getByLabel("学科", { exact: true }).selectOption("00000000-0000-4000-8000-00000000b011");
      await page.getByLabel("クラス", { exact: true }).selectOption(`00000000-0000-4000-8000-00000000c11${i + 1}`);
      await page.getByRole("button", { name: "次へ", exact: true }).click();
      await page.getByRole("button", { name: "次へ", exact: true }).click();
      await page.getByRole("checkbox", { name: "友達がほしい", exact: true }).check();
      await page.getByLabel("自己紹介（任意）", { exact: true }).fill("架空の動作確認用プロフィールです。");
      await page.getByRole("button", { name: "確認へ", exact: true }).click();
      await page.getByRole("button", { name: "プロフィールを保存", exact: true }).click();
      // SEC-007: the upload is a same-origin POST to the route handler, not a Server Action.
      const uploaded = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/photos" && response.request().method() === "POST");
      await page.getByLabel("写真を追加", { exact: true }).setInputFiles({ name: "fictional.png", mimeType: "image/png", buffer: await photoPng() });
      const upload = await uploaded;
      expect(upload.status()).toBe(200);
      expect(await upload.json()).toEqual({ status: "ok" });
      expect(upload.headers()["cache-control"]).toBe("no-store");
      await loadedPhoto(page, "登録した写真 1");
      if (i === 0) large = await largePhoto(page);
      await page.getByRole("button", { name: "プロフィールを完成", exact: true }).click();
      await expect(page.getByText("プロフィールを作成しました。", { exact: true })).toBeVisible();
    } finally { await page.context().close(); }
  }
  evidence("onboarding", { status: "pass", ownerPhotoLoaded: true, largePhoto: large });
});
