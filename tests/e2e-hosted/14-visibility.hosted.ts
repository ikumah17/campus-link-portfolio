import { test, expect, type Browser, type Page } from "@playwright/test";
import { Oracle, type Snapshot } from "../db/oracle";
import { createRunUsers } from "./lifecycle";
import { appGet } from "./request";
import { evidence, readState } from "./state";
import { adminPage, loadedPhoto, photoPng, submissionIds, userPage } from "./ui";

// HOSTED-E2E-005, its own invocation (CAMPUS_E2E_VISIBILITY=1): the docs/01 Privacy Protection rows on hosted.
// Five fictional run users: V viewer, S same class as V, D same department as V and S in the other class (A1-2), O other
// school, and U same as S with its affiliation left unconfirmed. Every expectation is the local oracle (tests/db/oracle.ts, which NT-05..NT-08
// and NT-20 hold equal to the database) evaluated over the state this file sets through the app; it is never derived
// from what hosted answered. Each check compares every ordered pair on the discover list, the detail page and the photo
// route from the viewer's own browser session. A disagreement is a soft failure recorded as a finding; the next case
// still runs. Evidence keeps role letters, counts and pass/fail only. Teardown deletes all five users.
test.describe.configure({ mode: "serial" });

const ROLES = ["V", "S", "D", "O", "U"] as const;
type Role = typeof ROLES[number];
const id = (suffix: string) => `00000000-0000-4000-8000-00000000${suffix}`;
// The fictional affiliation master already on hosted (scripts/e2e-hosted/bootstrap.sql); no master rows are added.
const SCHOOL = { A: { id: id("a001"), name: "デモ学校A（架空）" }, B: { id: id("a002"), name: "デモ学校B（架空）" } };
const DEPARTMENT = { A1: "デモ学科A1（架空）", B1: "デモ学科B1（架空）" };
const CLASS = { A11: "デモクラスA1-1（架空）", A12: "デモクラスA1-2（架空）", B11: "デモクラスB1-1（架空）" };
type Affiliation = { school: string; department: string; class: string; names: [string, string, string] };
const A11: Affiliation = { school: SCHOOL.A.id, department: id("b011"), class: id("c111"), names: [SCHOOL.A.name, DEPARTMENT.A1, CLASS.A11] };
const AFFILIATION: Record<Role, Affiliation> = {
  V: A11, S: A11, U: A11,
  D: { school: SCHOOL.A.id, department: id("b011"), class: id("c112"), names: [SCHOOL.A.name, DEPARTMENT.A1, CLASS.A12] },
  O: { school: SCHOOL.B.id, department: id("b021"), class: id("c211"), names: [SCHOOL.B.name, DEPARTMENT.B1, CLASS.B11] },
};
const BIRTH = "2000-01-02";

// docs/04 privacy_settings defaults (also what onboarding inserts): hide_same_class true, everything else false.
type Settings = { hideSameClass: boolean; hideSameDepartment: boolean; hideSameSchool: boolean; showDepartment: boolean; showClass: boolean;
  schools: string[]; departments: string[]; classes: string[] };
type Flag = "hideSameClass" | "hideSameDepartment" | "hideSameSchool" | "showDepartment" | "showClass";
const SWITCH: Record<Flag, string> = { hideSameClass: "同じクラスに表示しない", hideSameDepartment: "同じ学科に表示しない",
  hideSameSchool: "同じ学校に表示しない", showDepartment: "学科名を公開", showClass: "クラス名を公開" };
type Target = { kind: "schools" | "departments" | "classes"; id: string; label: string };
const TARGET = {
  schoolB: { kind: "schools", id: SCHOOL.B.id, label: SCHOOL.B.name },
  departmentA1: { kind: "departments", id: id("b011"), label: `${SCHOOL.A.name} / ${DEPARTMENT.A1}` },
  classA11: { kind: "classes", id: id("c111"), label: `${SCHOOL.A.name} / ${DEPARTMENT.A1} / ${CLASS.A11}` },
  classA12: { kind: "classes", id: id("c112"), label: `${SCHOOL.A.name} / ${DEPARTMENT.A1} / ${CLASS.A12}` },
} as const satisfies Record<string, Target>;

const model = Object.fromEntries(ROLES.map(role => [role, { hideSameClass: true, hideSameDepartment: false, hideSameSchool: false,
  showDepartment: false, showClass: false, schools: [], departments: [], classes: [] } as Settings])) as Record<Role, Settings>;
const photos = {} as Record<Role, string>;
const user = (role: Role) => readState().users[ROLES.indexOf(role)];

// The oracle over the state this run created: all five completed, adult, age-verified, one active photo;
// V, S, D, O confirmed and U 'unconfirmed' (never submitted enrollment). No blocks, likes or connections.
function oracle(): Oracle {
  const now = Date.now();
  const s: Snapshot = { now, profiles: new Map(), birth: new Map(), age: new Map(), affiliations: new Map(), settings: new Map(),
    hidden: [], photos: [], likes: new Set(), modes: new Map(), blocks: new Set(), connections: [], conversations: new Map() };
  for (const role of ROLES) {
    const uid = user(role).id, a = AFFILIATION[role], m = model[role], confirmed = role !== "U";
    s.profiles.set(uid, { user_id: uid, account_status: "active", completed: true });
    s.birth.set(uid, BIRTH);
    s.age.set(uid, { verified: true, revoked: false });
    s.affiliations.set(uid, { user_id: uid, school_id: a.school, department_id: a.department, class_id: a.class,
      status: confirmed ? "confirmed" : "unconfirmed", confirmed_until: confirmed ? String(now + 86_400_000) : null });
    s.settings.set(uid, { user_id: uid, hide_same_class: m.hideSameClass, hide_same_department: m.hideSameDepartment, hide_same_school: m.hideSameSchool });
    for (const school of m.schools) s.hidden.push({ user_id: uid, school_id: school, department_id: null, class_id: null });
    for (const department of m.departments) s.hidden.push({ user_id: uid, school_id: null, department_id: department, class_id: null });
    for (const cls of m.classes) s.hidden.push({ user_id: uid, school_id: null, department_id: null, class_id: cls });
    s.photos.push({ id: photos[role], user_id: uid, status: "active" });
  }
  return new Oracle(s);
}

async function onboard(browser: Browser, role: Role) {
  const index = ROLES.indexOf(role), a = AFFILIATION[role];
  const page = await userPage(browser, index, "/onboarding");
  try {
    await page.getByLabel("表示名", { exact: true }).fill(user(role).name);
    await page.getByRole("radio", { name: "その他", exact: true }).check();
    await page.getByLabel("生年月日", { exact: true }).fill(BIRTH);
    await page.getByLabel("18歳以上です", { exact: true }).check();
    await page.getByRole("button", { name: "次へ", exact: true }).click();
    await page.getByLabel("学校", { exact: true }).selectOption(a.school);
    await page.getByLabel("学科", { exact: true }).selectOption(a.department);
    await page.getByLabel("クラス", { exact: true }).selectOption(a.class);
    await page.getByRole("button", { name: "次へ", exact: true }).click();
    await page.getByRole("button", { name: "次へ", exact: true }).click();
    await page.getByRole("checkbox", { name: "友達がほしい", exact: true }).check();
    await page.getByLabel("自己紹介（任意）", { exact: true }).fill("架空の動作確認用プロフィールです。");
    await page.getByRole("button", { name: "確認へ", exact: true }).click();
    await page.getByRole("button", { name: "プロフィールを保存", exact: true }).click();
    await page.getByLabel("写真を追加", { exact: true }).setInputFiles({ name: "fictional.png", mimeType: "image/png", buffer: await photoPng() });
    await loadedPhoto(page, "登録した写真 1");
    photos[role] = (await page.getByAltText("登録した写真 1", { exact: true }).getAttribute("src"))!.replace("/media/photos/", "");
    await page.getByRole("button", { name: "プロフィールを完成", exact: true }).click();
    await expect(page.getByText("プロフィールを作成しました。", { exact: true })).toBeVisible();
    // The same synthetic submissions as group 2. U submits age only, so its affiliation stays 'unconfirmed'.
    await page.goto("/verification");
    const kinds = role === "U" ? ["年齢確認"] : ["年齢確認", "在学確認"];
    for (const title of kinds) {
      const section = page.getByRole("region", { name: title, exact: true });
      await section.getByRole("button", { name: "架空のサンプル資料1", exact: true }).click();
      await section.getByRole("button", { name: "提出", exact: true }).click();
      await expect(section.getByText("提出済み", { exact: true })).toBeVisible();
    }
    await page.reload();
    const own = await submissionIds(page);
    expect(new Set(own).size).toBe(kinds.length);
    return [...new Set(own)];
  } finally { await page.context().close(); }
}

test("five fictional users are onboarded; four are fully verified and U's affiliation stays unconfirmed", async ({ browser }) => {
  test.setTimeout(900_000);
  await createRunUsers(3);
  expect(readState().users).toHaveLength(ROLES.length);
  const ids: string[] = [];
  for (const role of ROLES) ids.push(...await onboard(browser, role));
  const admin = await adminPage(browser);
  try {
    for (const submission of ids) {
      await admin.goto("/admin/verifications");
      // Claim only this run's own submitted IDs, matched to the queue's serialized props as in group 2.
      const index = (await submissionIds(admin)).indexOf(submission);
      expect(index, "run-owned submission is in the rendered review queue").toBeGreaterThanOrEqual(0);
      await admin.getByRole("region", { name: "提出一覧" }).getByRole("listitem").nth(index).getByRole("button", { name: "担当する" }).click();
      await expect(admin).toHaveURL(new RegExp(`/admin/verifications/${submission}$`));
      await admin.getByRole("button", { name: "承認", exact: true }).click();
      await expect(admin.getByRole("status")).toHaveText("審査結果を保存しました。");
    }
  } finally { await admin.context().close(); }
  for (const role of ROLES) {
    const page = await userPage(browser, ROLES.indexOf(role));
    try { await expect(page.getByRole("region", { name: "確認状況" }).getByText("確認済み", { exact: true })).toHaveCount(role === "U" ? 1 : 2); }
    finally { await page.context().close(); }
  }
  evidence("visibilityWorld", { status: "pass", users: ROLES.length, approvals: ids.length, confirmed: 4, unconfirmed: 1 });
});

type Observed = { list: "list" | "notEligible" | "unexpected"; truncated: boolean; listed: Set<Role>; detail: Map<Role, boolean | null>; photo: Map<Role, boolean | null> };
const roleOfName = () => new Map(ROLES.map(role => [`${user(role).name}のプロフィールを見る`, role]));

// Every run user named on the current discover page and its following pages. Other hosted profiles are ignored.
// A list still offering more after the page cap is truncated: the caller fails it instead of judging a partial list.
const PAGE_CAP = 10;
async function collect(page: Page) {
  const names = roleOfName(), listed = new Set<Role>();
  for (let pages = 0; ; pages++) {
    const labels = await page.getByRole("link", { name: /のプロフィールを見る$/ }).evaluateAll(links => links.map(link => link.getAttribute("aria-label")));
    for (const label of labels) if (names.has(label!)) listed.add(names.get(label!)!);
    const next = page.getByRole("link", { name: "次のプロフィールを見る", exact: true });
    if (!await next.count()) return { listed, truncated: false };
    if (pages >= PAGE_CAP) return { listed, truncated: true };
    await page.goto((await next.getAttribute("href"))!);
  }
}
async function observe(page: Page, viewer: Role): Promise<Observed> {
  await page.goto("/");
  const notEligible = await page.getByText("在学・年齢確認が終わると、プロフィールを探せます。", { exact: true }).count();
  const kind = await page.getByRole("link", { name: "検索条件", exact: true }).count() ? "list" : notEligible ? "notEligible" : "unexpected";
  const { listed, truncated } = kind === "list" ? await collect(page) : { listed: new Set<Role>(), truncated: false };
  const list = truncated ? "unexpected" : kind;
  const detail = new Map<Role, boolean | null>(), photo = new Map<Role, boolean | null>();
  for (const target of ROLES.filter(role => role !== viewer)) {
    // A hidden target answers exactly like a missing ID: the profile not-found page (HTTP 404) without the target's name.
    // A shown profile is HTTP 200 with the name and without the fixed failure alert (its payload also carries the
    // not-found boundary text, so that text alone does not classify a page).
    const response = await appGet(page.request, `/profiles/${user(target).id}`);
    const html = await response.text(), named = html.includes(user(target).name), missing = html.includes("プロフィールが見つかりません");
    detail.set(target, response.status() === 200 && named && !html.includes("現在表示できません") ? true
      : response.status() === 404 && missing && !named ? false : null);
    const image = await appGet(page.request, `/media/photos/${photos[target]}`);
    photo.set(target, image.status() === 200 && /^image\//.test(image.headers()["content-type"] ?? "") ? true
      : image.status() === 404 && image.headers()["cache-control"] === "no-store" ? false : null);
  }
  return { list, truncated, listed, detail, photo };
}

const cases: Record<string, unknown>[] = [];
const findings: string[] = [];
function record(entry: Record<string, unknown>, mismatches: string[]) {
  cases.push({ ...entry, pass: mismatches.length === 0 });
  findings.push(...mismatches.map(pair => `${entry.case} ${pair}`));
  evidence("visibility", { status: findings.length ? "fail" : "running", cases, findings });
}

// Rules (docs/04 §private.pair_visible/hides/can_view_profile/can_see_identity; the oracle implements them independently):
// - pair_visible(a, b) = a <> b, both eligible, no block, not hides(a, b) and not hides(b, a): symmetric by definition.
// - hides(owner, other): (hide_same_class default true and same class) or (hide_same_department and same department) or
//   (hide_same_school and same school) or a hidden_affiliations row naming other's school, department or class.
// - is_eligible needs a confirmed, unexpired affiliation (docs/01: 所属情報が未確認の場合は安全側に制限する).
// - discover (NT-07) lists exactly can_view_profile minus self and relations; get_profile returns a row exactly when
//   can_view_profile; authorize_photo_delivery (NT-20) allows exactly can_see_identity (pair_visible).
async function check(pages: Record<Role, Page>, name: string, rule: string) {
  const o = oracle(), ids = Object.fromEntries(ROLES.map(role => [role, user(role).id])) as Record<Role, string>;
  const seen = await Promise.all(ROLES.map(viewer => observe(pages[viewer], viewer)));
  const surfaces = { list: { visible: [] as string[], hidden: [] as string[], mismatches: [] as string[] },
    detail: { visible: [] as string[], hidden: [] as string[], mismatches: [] as string[] },
    photo: { visible: [] as string[], hidden: [] as string[], mismatches: [] as string[] } };
  const listKind: string[] = [];
  ROLES.forEach((viewer, i) => {
    const expectedKind = o.eligible(ids[viewer]) ? "list" : "notEligible";
    if (seen[i].list !== expectedKind) listKind.push(`${viewer}:${seen[i].list}${seen[i].truncated ? " (truncated)" : ""}`);
    for (const target of ROLES.filter(role => role !== viewer)) {
      const pair = `${viewer}>${target}`;
      const expected = { list: o.canViewProfile(ids[viewer], ids[target]), detail: o.canViewProfile(ids[viewer], ids[target]),
        photo: o.photoDeliveryAllowed(ids[viewer], photos[target]) };
      const observed = { list: seen[i].listed.has(target), detail: seen[i].detail.get(target), photo: seen[i].photo.get(target) };
      for (const surface of ["list", "detail", "photo"] as const) {
        surfaces[surface][observed[surface] ? "visible" : "hidden"].push(pair);
        if (observed[surface] !== expected[surface]) surfaces[surface].mismatches.push(`${surface}:${pair}:expected ${expected[surface] ? "visible" : "hidden"}, observed ${observed[surface] ?? "unexpected"}`);
      }
    }
  });
  const mismatches = [...listKind.map(kind => `listKind:${kind}`), ...Object.values(surfaces).flatMap(surface => surface.mismatches)];
  record({ case: name, rule, pairs: ROLES.length * (ROLES.length - 1), listKind: listKind.length ? listKind : "as expected", surfaces }, mismatches);
  expect.soft(mismatches, `${name}: hosted must equal the oracle on list, detail and photo`).toEqual([]);
}

async function setPrivacy(page: Page, role: Role, change: Partial<Record<Flag, boolean>>, targets: { add?: Target[]; remove?: Target[] } = {}) {
  const current = model[role];
  await page.goto("/settings/privacy");
  // The screen must show the state the oracle models before anything changes.
  for (const [flag, title] of Object.entries(SWITCH) as [Flag, string][]) {
    await expect(page.getByRole("switch", { name: title, exact: true })).toHaveAttribute("aria-checked", String(current[flag]));
  }
  const manage = page.getByRole("button", { name: /非表示対象を管理/ });
  await expect(manage).toContainText(`${current.schools.length + current.departments.length + current.classes.length}件指定中`);
  for (const [flag, value] of Object.entries(change) as [Flag, boolean][]) {
    if (current[flag] !== value) await page.getByRole("switch", { name: SWITCH[flag], exact: true }).click();
  }
  if (targets.add?.length || targets.remove?.length) {
    await manage.click();
    for (const target of targets.add ?? []) await page.getByRole("button", { name: `${target.label}を追加`, exact: true }).click();
    for (const target of targets.remove ?? []) await page.getByRole("button", { name: `${target.label}を解除`, exact: true }).click();
  }
  await page.getByRole("button", { name: "保存する" }).click();
  await expect(page.getByRole("status")).toHaveText("保存しました。");
  const next = { ...current, ...change };
  for (const target of targets.add ?? []) next[target.kind] = [...next[target.kind], target.id];
  for (const target of targets.remove ?? []) next[target.kind] = next[target.kind].filter(value => value !== target.id);
  model[role] = next;
}

// (f) /search offers only the school filter (学科・クラスでの絞り込みは提供していません). Results = the unfiltered oracle set
// narrowed by school (NT-07: filters only narrow); every listed card shows that school. An ineligible viewer's expected
// set is empty, so its run is recorded as an ineligibility check, not as search coverage.
async function search(page: Page, viewer: Role, school: { id: string; name: string }, name: string, purpose: "search" | "ineligibility" = "search") {
  await page.goto("/search", { waitUntil: "networkidle" });
  const box = page.getByRole("checkbox", { name: school.name, exact: true });
  await box.check();
  await expect(box).toBeChecked();
  await page.getByRole("button", { name: "この条件で探す", exact: true }).click();
  await page.waitForURL(url => url.pathname === "/" && url.searchParams.getAll("s").join() === school.id);
  const cards = page.getByRole("article");
  const outside = await cards.evaluateAll((items, text) => items.filter(item => !item.textContent?.includes(text)).length, school.name);
  const { listed, truncated } = await collect(page);
  const o = oracle(), vid = user(viewer).id;
  const expected = ROLES.filter(t => t !== viewer && o.canViewProfile(vid, user(t).id) && AFFILIATION[t].school === school.id);
  const mismatches = [...(outside ? [`search:${viewer}:${outside} card(s) outside the filter`] : []), ...(truncated ? [`search:${viewer}:unexpected (truncated)`] : []),
    ...ROLES.filter(t => listed.has(t) !== expected.includes(t)).map(t => `search:${viewer}>${t}:expected ${expected.includes(t) ? "visible" : "hidden"}`)];
  const rule = purpose === "search" ? "NT-07 discover filters only narrow; pair_visible still applies"
    : "is_eligible: an unconfirmed viewer's filtered search lists nobody (ineligibility check, not search coverage)";
  record({ case: name, rule, surface: purpose, viewer,
    expected: expected.map(t => `${viewer}>${t}`), observed: [...listed].map(t => `${viewer}>${t}`) }, mismatches);
  expect.soft(mismatches, `${name}: search must equal the narrowed oracle set`).toEqual([]);
}

// (d) docs/04 profile_view: department_name / class_name only when the owner's show_department / show_class is true.
// The detail page (and the discover card) prints school / department / class without the withheld parts.
async function disclosure(pages: Record<Role, Page>, subject: Role, viewers: Role[], name: string) {
  const [school, department, cls] = AFFILIATION[subject].names, m = model[subject];
  const line = [school, m.showDepartment ? department : null, m.showClass ? cls : null].filter(value => value !== null).join(" / ");
  const withheld = [!m.showDepartment ? department : null, !m.showClass ? cls : null].filter(value => value !== null) as string[];
  const mismatches: string[] = [];
  for (const viewer of viewers) {
    const page = pages[viewer];
    await page.goto(`/profiles/${user(subject).id}`);
    const main = page.getByRole("main");
    await expect(main.getByRole("heading", { level: 1 })).toContainText(user(subject).name);
    const text = await main.innerText();
    if (await main.getByText(line, { exact: true }).count() !== 1) mismatches.push(`detail:${viewer}>${subject}:line`);
    if (withheld.some(value => text.includes(value))) mismatches.push(`detail:${viewer}>${subject}:withheld part shown`);
    await page.goto("/");
    const card = page.getByRole("article").filter({ has: page.getByRole("link", { name: `${user(subject).name}のプロフィールを見る`, exact: true }) });
    const cardText = await card.innerText();
    if (await card.getByText(line, { exact: true }).count() !== 1) mismatches.push(`list:${viewer}>${subject}:line`);
    if (withheld.some(value => cardText.includes(value))) mismatches.push(`list:${viewer}>${subject}:withheld part shown`);
  }
  record({ case: name, rule: "docs/04 profile_view show_department/show_class", subject,
    shown: { department: m.showDepartment, class: m.showClass }, viewers: viewers.map(viewer => `${viewer}>${subject}`) }, mismatches);
  expect.soft(mismatches, `${name}: the detail page discloses only what the owner shows`).toEqual([]);
}

test("class, department, school and specified-affiliation hiding, disclosure, unconfirmed affiliation and search equal the oracle on hosted", async ({ browser }) => {
  test.setTimeout(1_800_000);
  const opened: Page[] = [];
  try {
    for (const role of ROLES) opened.push(await userPage(browser, ROLES.indexOf(role), "/"));
    const pages = Object.fromEntries(ROLES.map((role, i) => [role, opened[i]])) as Record<Role, Page>;

    // (a) Defaults only. Same-class V-S is hidden because both default to hide_same_class; U is ineligible.
    await check(pages, "a-baseline", "defaults: hide_same_class true; U unconfirmed");

    // (b) Same class. V alone turning it off does not reveal S: S's own default still hides the pair both ways.
    await setPrivacy(pages.V, "V", { hideSameClass: false });
    await check(pages, "b-class-viewer-off-only", "hides(S, V) alone hides both directions");
    await setPrivacy(pages.S, "S", { hideSameClass: false });
    await check(pages, "b-class-both-off", "neither hides: V-S visible both ways");
    await search(pages.V, "V", SCHOOL.A, "f-search-school-A-all-visible");
    await search(pages.V, "V", SCHOOL.B, "f-search-school-B-all-visible");
    await setPrivacy(pages.S, "S", { hideSameClass: true });
    await check(pages, "b-class-subject-on", "hide_same_class: S hides V both ways; D, O unchanged");
    await setPrivacy(pages.S, "S", { hideSameClass: false });
    await check(pages, "b-class-subject-off", "restored");
    // Same department (V in S's class, D in the other class A1-2) and same school.
    await setPrivacy(pages.S, "S", { hideSameDepartment: true });
    await check(pages, "b-department-on", "hide_same_department: S-V, S-D hidden both ways; S-O visible");
    await setPrivacy(pages.S, "S", { hideSameDepartment: false });
    await check(pages, "b-department-off", "restored");
    // D shares no class with anyone, so its default hide_same_class hides nobody; with it still on, D's department
    // switch alone hides the other-class peers V and S.
    await setPrivacy(pages.D, "D", { hideSameDepartment: true });
    await check(pages, "b-department-other-class-on", "hide_same_department with hide_same_class on: D-V, D-S (other class) hidden both ways; D-O visible");
    await setPrivacy(pages.D, "D", { hideSameDepartment: false });
    await check(pages, "b-department-other-class-off", "restored");
    await setPrivacy(pages.S, "S", { hideSameSchool: true });
    await check(pages, "b-school-on", "hide_same_school: S-V, S-D hidden both ways; S-O visible");
    await setPrivacy(pages.S, "S", { hideSameSchool: false });
    await check(pages, "b-school-off", "restored");

    // (c) Specified affiliation through 非表示対象を管理: one school, one department and each class of department A1,
    // each removed again.
    await setPrivacy(pages.S, "S", {}, { add: [TARGET.schoolB] });
    await check(pages, "c-hidden-school-B", "hidden_affiliations school: S-O hidden both ways");
    await search(pages.O, "O", SCHOOL.A, "f-search-school-A-from-O-while-S-hides-B");
    await search(pages.S, "S", SCHOOL.B, "f-search-school-B-from-S-while-S-hides-B");
    await setPrivacy(pages.S, "S", {}, { remove: [TARGET.schoolB] });
    await check(pages, "c-hidden-school-removed", "restored");
    await setPrivacy(pages.S, "S", {}, { add: [TARGET.departmentA1] });
    await check(pages, "c-hidden-department-A1", "hidden_affiliations department: S-V, S-D hidden both ways; S-O visible");
    await setPrivacy(pages.S, "S", {}, { remove: [TARGET.departmentA1] });
    await check(pages, "c-hidden-department-removed", "restored");
    await setPrivacy(pages.S, "S", {}, { add: [TARGET.classA11] });
    await check(pages, "c-hidden-class-A1-1", "hidden_affiliations class: S-V hidden both ways; S-D (A1-2) visible");
    await setPrivacy(pages.S, "S", {}, { remove: [TARGET.classA11] });
    await check(pages, "c-hidden-class-removed", "restored");
    await setPrivacy(pages.S, "S", {}, { add: [TARGET.classA12] });
    await check(pages, "c-hidden-class-A1-2", "hidden_affiliations class: S-D hidden both ways; S-V (A1-1) visible");
    await setPrivacy(pages.S, "S", {}, { remove: [TARGET.classA12] });
    await check(pages, "c-hidden-class-A1-2-removed", "restored");

    // (d) Department and class disclosure is optional and changes nothing else.
    await disclosure(pages, "S", ["V", "O"], "d-default-withheld");
    await setPrivacy(pages.S, "S", { showDepartment: true });
    await disclosure(pages, "S", ["V", "O"], "d-department-shown");
    await check(pages, "d-department-shown-visibility", "disclosure does not change visibility");
    await setPrivacy(pages.S, "S", { showDepartment: false, showClass: true });
    await disclosure(pages, "S", ["V", "O"], "d-class-shown");
    await check(pages, "d-class-shown-visibility", "disclosure does not change visibility");
    await setPrivacy(pages.S, "S", { showClass: false });
    await disclosure(pages, "S", ["V", "O"], "d-withheld-again");

    // (e) U's only missing condition is its affiliation once U also stops hiding its own class: V and S (same class,
    // both not hiding it) still never see U, and U sees nobody, on every surface.
    await setPrivacy(pages.U, "U", { hideSameClass: false });
    await check(pages, "e-unconfirmed-isolated", "is_eligible: unconfirmed affiliation hides U both ways");
    await pages.U.goto("/");
    await expect(pages.U.getByText("在学・年齢確認が終わると、プロフィールを探せます。", { exact: true })).toBeVisible();
    await search(pages.U, "U", SCHOOL.A, "e-unconfirmed-search-ineligible", "ineligibility");

    evidence("visibility", { status: findings.length ? "fail" : "pass", cases, findings });
  } finally { for (const page of opened) await page.context().close(); }
});
