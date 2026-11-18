import { test, expect, type Browser } from "@playwright/test";
import { readBackRunUser } from "./lifecycle";
import { ownSession, sweep, sweepCounts, sweepMismatch } from "./retention";
import { evidence, readState, retentionMode, saveState } from "./state";
import { loadedPhoto, photoPng, userPage } from "./ui";
import { Session, isAdmin, staff } from "./concurrency";

// HOSTED-RET-001, two separate invocations. prepare: U (users[0]) deletes its own account, K (users[1]) stays
// active, and the ledger is kept for the coordinator's 31-day backdate of U. verify: exactly one --apply, only
// after a dry run that lists exactly U and its photos; then read-back and a second dry run listing nothing.
const mode = retentionMode();

async function onboard(browser: Browser, i: number) {
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
    await page.getByLabel("写真を追加", { exact: true }).setInputFiles({ name: "fictional.png", mimeType: "image/png", buffer: await photoPng() });
    await loadedPhoto(page, "登録した写真 1");
    await page.getByRole("button", { name: "プロフィールを完成", exact: true }).click();
    await expect(page.getByText("プロフィールを作成しました。", { exact: true })).toBeVisible();
  } finally { await page.context().close(); }
}

if (mode === "prepare") test("retention prepare: U deletes its own account, K stays active", async ({ browser }) => {
  test.setTimeout(300_000);
  for (const i of [0, 1]) await onboard(browser, i);
  const before = [await readBackRunUser(0), await readBackRunUser(1)];
  for (const user of before) expect({ auth: user.authStatus, identity: user.identity, photos: user.photos.length }).toEqual({ auth: 200, identity: true, photos: 1 });

  // The app has no account-deletion screen: U calls the app's request_account_deletion RPC with its own JWT.
  const u = await ownSession(0);
  const deletion = await u.rpc("request_account_deletion");
  expect({ status: deletion.status, ok: deletion.ok, code: deletion.code }).toEqual({ status: 200, ok: true, code: "ok" });
  expect(await u.accountStatus()).toBe("deleted");
  expect(await (await ownSession(1)).accountStatus()).toBe("active");
  evidence("retentionPrepare", { status: "pass", onboarded: 2, photos: [1, 1], deletionRoute: "request_account_deletion RPC (own JWT; no app screen)",
    deletion: { status: deletion.status, code: deletion.code }, deletedAccountStatus: "deleted", controlAccountStatus: "active" });

  // Kept for verify without passwords: nothing after this point signs in as U or K.
  const state = readState();
  state.users = state.users.map(user => ({ ...user, password: "" }));
  state.retention = { phase: "prepared", photos: [before[0].photos, before[1].photos] };
  saveState(state);
});

if (mode === "verify") test("retention verify: one --apply removes exactly the expired run account", async () => {
  test.setTimeout(300_000);
  const state = readState();
  const retention = state.retention!;
  const deleted = state.users[0];
  const [u, k] = [await readBackRunUser(0), await readBackRunUser(1)];
  expect({ auth: u.authStatus, identity: u.identity, photos: u.photos }).toEqual({ auth: 200, identity: true, photos: retention.photos[0] });
  expect({ auth: k.authStatus, identity: k.identity, photos: k.photos }).toEqual({ auth: 200, identity: true, photos: retention.photos[1] });

  const expected = { id: deleted.id, photos: u.photos.length };
  const dryRun = await sweep(false);
  evidence("retentionDryRunBefore", sweepCounts(dryRun));
  expect(sweepMismatch(dryRun, "dry-run", expected), "dry run must list exactly the run's expired account; --apply not run").toBeNull();

  // Persisted before the only --apply: a re-run of verify, or any cleanup, refuses until the coordinator resolves it.
  state.retention = { ...retention, phase: "applying" };
  saveState(state);
  const applied = await sweep(true);
  evidence("retentionApply", sweepCounts(applied));
  if (applied.exit === 0 && applied.summary?.ok === true) saveState({ ...state, retention: { ...retention, phase: "applied" } });
  expect(sweepMismatch(applied, "apply", expected), "apply summary").toBeNull();

  const [uAfter, kAfter] = [await readBackRunUser(0), await readBackRunUser(1)];
  const admin = await Session.signIn("admin", true);
  const readBack = { deletedAuthStatus: uAfter.authStatus, deletedPhotos: uAfter.photos.length,
    controlAuthStatus: kAfter.authStatus, controlIdentity: kAfter.identity, controlPhotosUnchanged: JSON.stringify(kAfter.photos) === JSON.stringify(k.photos),
    adminActive: isAdmin(await staff(admin), admin.id) };
  evidence("retentionReadBack", readBack);
  expect(readBack).toEqual({ deletedAuthStatus: 404, deletedPhotos: 0, controlAuthStatus: 200, controlIdentity: true,
    controlPhotosUnchanged: true, adminActive: true });

  const dryRunAfter = await sweep(false);
  evidence("retentionDryRunAfter", sweepCounts(dryRunAfter));
  expect(sweepMismatch(dryRunAfter, "dry-run", null), "second dry run lists nothing").toBeNull();
  saveState({ ...readState(), retention: { ...retention, phase: "verified" } });
  evidence("retentionVerify", { status: "pass" });
});
