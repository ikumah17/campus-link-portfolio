import { act, fireEvent, renderRouter, screen, waitFor, within } from "expo-router/testing-library";
import * as WebBrowser from "expo-web-browser";
import { AppShell } from "../src/app-shell";
import type { AuthServices } from "../src/auth-context";
import {
  accountMessages, accountText, blocksText, LOAD_UNAVAILABLE, myPageText, onboardingText, PAUSE_NOTE, privacyText, profileEditText, safetyMessages,
  settingsLinks, unblockText,
} from "../src/messages";
import { authMessages } from "../src/shared";
import WelcomeScreen from "../app/index";
import HomeScreen from "../app/home";
import MyPageScreen from "../app/mypage";
import OnboardingScreen from "../app/onboarding";
import SignInScreen from "../app/sign-in";
import AccountScreen from "../app/settings/account";
import BlocksScreen from "../app/settings/blocks";
import PrivacyScreen from "../app/settings/privacy";
import ProfileEditScreen from "../app/settings/profile";
import {
  accountRow, DEPT, done, fakeSupabase, masterTables, ok, PHOTO_A, raised, refusal, SCHOOL, TARGET, type RpcAnswer, type TableAnswer,
} from "./fake-supabase";

// MOBILE-004: the states of the settings screens, the in-app browser links, and both sign-outs.
jest.mock("expo-image", () => {
  const { View } = jest.requireActual("react-native");
  const Image = (props: Record<string, unknown>) => <View {...props} />;
  Image.clearMemoryCache = jest.fn(async () => true);
  return { Image };
});
jest.mock("expo-web-browser", () => ({ openBrowserAsync: jest.fn(async () => ({ type: "opened" })) }));

type Listener = (event: string, session: unknown) => void;
type SignOutAnswer = "ok" | "error" | "throw";

function fakeServices(rpc: (name: string, args: Record<string, unknown>) => RpcAnswer, tables: Record<string, TableAnswer> = {},
  global: SignOutAnswer = "ok") {
  let session: unknown = { access_token: "aaa.bbb.ccc" };
  const listeners: Listener[] = [];
  const auth = {
    getSession: jest.fn(async () => ({ data: { session }, error: null })),
    onAuthStateChange: jest.fn((listener: Listener) => { listeners.push(listener); return { data: { subscription: { unsubscribe: jest.fn() } } }; }),
    startAutoRefresh: jest.fn(async () => {}),
    stopAutoRefresh: jest.fn(async () => {}),
    // Like auth-js: a revoke that fails still removes this device's session and answers { error }.
    signOut: jest.fn(async ({ scope }: { scope: string }) => {
      if (scope === "global" && global === "throw") throw new Error("network");
      session = null;
      listeners.forEach((listener) => listener("SIGNED_OUT", null));
      return { error: scope === "global" && global === "error" ? { name: "AuthRetryableFetchError", status: 0 } : null };
    }),
  };
  const db = fakeSupabase(rpc, tables);
  const clearImages = jest.fn(async () => true);
  const clearSession = jest.fn(async () => {});
  const services = {
    api: { signIn: jest.fn(), signUp: jest.fn() }, supabase: { auth, rpc: db.rpc, from: db.from },
    termsUrl: "http://host:3000/terms", privacyUrl: "http://host:3000/privacy", apiBaseUrl: "http://host:3000",
    photos: { upload: jest.fn(), remove: jest.fn(), token: jest.fn(async () => "aaa.bbb.ccc") }, clearImages, clearSession,
  };
  return { services: services as unknown as AuthServices, auth, db, clearImages, clearSession };
}

async function open(services: AuthServices, initialUrl: string) {
  function Layout() {
    return <AppShell services={services} />;
  }
  return renderRouter({
    _layout: Layout, index: WelcomeScreen, home: HomeScreen, onboarding: OnboardingScreen, mypage: MyPageScreen, "sign-in": SignInScreen,
    "settings/privacy": PrivacyScreen, "settings/blocks": BlocksScreen, "settings/account": AccountScreen, "settings/profile": ProfileEditScreen,
  }, { initialUrl });
}

const calls = (db: ReturnType<typeof fakeSupabase>, name: string) => db.rpc.mock.calls.filter(([called]) => called === name);
const account = (overrides: Record<string, unknown> = {}) => ok([accountRow(overrides)]);
const myPageTables = {
  profiles: { data: [{ display_name: "架空の学生" }], error: null },
  profile_photos: { data: [{ id: PHOTO_A, position: 0 }], error: null },
};

beforeEach(() => jest.mocked(WebBrowser.openBrowserAsync).mockClear());

describe("my page (M4)", () => {
  it("links the privacy, block and account settings, and opens the legal pages in the in-app browser", async () => {
    const { services } = fakeServices(() => account(), myPageTables);
    const router = await open(services, "/mypage");
    await fireEvent.press(await screen.findByTestId("mypage-terms"));
    await fireEvent.press(screen.getByTestId("mypage-privacy"));
    expect(jest.mocked(WebBrowser.openBrowserAsync).mock.calls).toEqual([["http://host:3000/terms"], ["http://host:3000/privacy"]]);
    await fireEvent.press(screen.getByTestId("mypage-link-privacy"));
    await waitFor(() => expect(router.getPathname()).toBe("/settings/privacy"));
  });

  it("offers the way back from a paused account", async () => {
    const { services } = fakeServices(() => account({ account_status: "deactivated" }), myPageTables);
    const router = await open(services, "/mypage");
    expect(await screen.findByText(myPageText.deactivated)).toBeTruthy();
    await fireEvent.press(screen.getByText("再開する"));
    await waitFor(() => expect(router.getPathname()).toBe("/settings/account"));
  });
});

describe("sign-out (docs/42 §3.4)", () => {
  it("ends this device's session only and opens the welcome screen", async () => {
    const { services, auth, clearSession, clearImages } = fakeServices(() => account(), myPageTables);
    const router = await open(services, "/mypage");
    await fireEvent.press(await screen.findByTestId("sign-out"));
    await waitFor(() => expect(router.getPathname()).toBe("/"));
    expect(auth.signOut.mock.calls).toEqual([[{ scope: "local" }]]);
    expect(clearSession).toHaveBeenCalled();
    expect(clearImages).toHaveBeenCalled();
  });

  it("signs out everywhere with global scope and opens the welcome screen on success", async () => {
    const { services, auth, clearSession, clearImages } = fakeServices(() => account(), myPageTables);
    const router = await open(services, "/mypage");
    await fireEvent.press(await screen.findByTestId("sign-out-everywhere"));
    await waitFor(() => expect(router.getPathname()).toBe("/"));
    expect(auth.signOut.mock.calls).toEqual([[{ scope: "global" }]]);
    expect(clearSession).toHaveBeenCalled();
    expect(clearImages).toHaveBeenCalled();
    expect(await screen.findByText("新規登録")).toBeTruthy();
  });

  it.each(["error", "throw"] as const)("shows the web's signout text when the global revoke answers %s, and still clears the session", async (answer) => {
    const { services, auth, clearSession, clearImages } = fakeServices(() => account(), myPageTables, answer);
    const router = await open(services, "/mypage");
    await fireEvent.press(await screen.findByTestId("sign-out-everywhere"));
    await waitFor(() => expect(router.getPathname()).toBe("/sign-in"));
    expect(router.getSearchParams()).toEqual({ error: "signout" });
    expect(await screen.findByTestId("auth-signout-error")).toHaveTextContent(authMessages.signoutError);
    expect(auth.signOut.mock.calls).toEqual([[{ scope: "global" }], [{ scope: "local" }]]);
    expect(clearSession).toHaveBeenCalled();
    expect(clearImages).toHaveBeenCalled();
  });

  it("is on the account screen too", async () => {
    const { services, auth } = fakeServices(() => account(), {}, "error");
    const router = await open(services, "/settings/account");
    await fireEvent.press(await screen.findByTestId("sign-out-everywhere"));
    await waitFor(() => expect(router.getPathname()).toBe("/sign-in"));
    expect(auth.signOut.mock.calls[0]).toEqual([{ scope: "global" }]);
    expect(screen.queryByTestId("sign-out")).toBeNull();
  });
});

describe("privacy settings (M4)", () => {
  const tables = (privacy: unknown[] = [], hidden: unknown[] = []) => ({
    ...masterTables, privacy_settings: { data: privacy, error: null }, hidden_affiliations: { data: hidden, error: null },
  });
  const flagsOf = (db: ReturnType<typeof fakeSupabase>) => calls(db, "update_privacy_settings").at(-1)?.[1];

  it("shows the defaults, marks unsaved changes, and saves them", async () => {
    const { services, db } = fakeServices((name) => name === "my_account" ? account() : done(), tables());
    await open(services, "/settings/privacy");
    const sameClass = await screen.findByTestId("privacy-hideSameClass");
    expect(sameClass.props.accessibilityState).toMatchObject({ checked: true });
    expect(screen.getByTestId("privacy-showClass").props.accessibilityState).toMatchObject({ checked: false });
    await fireEvent.press(screen.getByTestId("privacy-hideSameSchool"));
    expect(screen.getByTestId("privacy-status")).toHaveTextContent(privacyText.dirty);
    await fireEvent.press(screen.getByTestId("privacy-save"));
    await waitFor(() => expect(screen.getByTestId("privacy-status")).toHaveTextContent(privacyText.saved));
    expect(flagsOf(db)).toMatchObject({ p_hide_same_class: true, p_hide_same_school: true, p_hidden_school_ids: [] });
  });

  it("adds and removes a hidden target and counts them", async () => {
    const { services, db } = fakeServices((name) => name === "my_account" ? account() : done(), tables([], [{ school_id: null, department_id: DEPT, class_id: null }]));
    await open(services, "/settings/privacy");
    expect(await screen.findByTestId("privacy-count")).toHaveTextContent(`1${privacyText.count}`);
    await fireEvent.press(screen.getByTestId("privacy-targets-toggle"));
    expect(screen.getByText(`架空大学 / 架空学科  ${privacyText.selected}`)).toBeTruthy();
    await fireEvent.press(screen.getByTestId("privacy-target-school-0"));
    await fireEvent.press(screen.getByTestId("privacy-target-department-0"));
    expect(screen.getByTestId("privacy-count")).toHaveTextContent(`1${privacyText.count}`);
    await fireEvent.press(screen.getByTestId("privacy-save"));
    await waitFor(() => expect(flagsOf(db)).toMatchObject({ p_hidden_school_ids: [SCHOOL], p_hidden_department_ids: [] }));
  });

  it("notes a hidden target whose affiliation is no longer active", async () => {
    const { services } = fakeServices(() => account(), tables([], [{ school_id: TARGET, department_id: null, class_id: null }]));
    await open(services, "/settings/privacy");
    expect(await screen.findByTestId("privacy-inactive")).toHaveTextContent(privacyText.inactive);
  });

  it.each([
    [refusal("rate_limited"), privacyText.errors.rate_limited],
    [{ data: null, error: { code: "P0001", message: "validation" }, status: 400 }, privacyText.errors.invalid],
    [{ data: null, error: { code: "PGRST301" }, status: 401 }, privacyText.errors.unauthenticated],
    [refusal("made_up"), privacyText.errors.unavailable],
  ] as [RpcAnswer, string][])("shows a refused save (%#)", async (answer, text) => {
    const { services } = fakeServices((name) => name === "my_account" ? account() : answer, tables());
    await open(services, "/settings/privacy");
    await fireEvent.press(await screen.findByTestId("privacy-save"));
    expect(await screen.findByTestId("privacy-error")).toHaveTextContent(text);
  });

  it("does not call values saved when they changed while the save ran", async () => {
    let finish: (value: RpcAnswer) => void = () => {};
    const { services } = fakeServices((name) => name === "my_account" ? account() : done(), tables());
    const rpc = services.supabase.rpc as unknown as jest.Mock;
    const original = rpc.getMockImplementation()!;
    rpc.mockImplementation((name: string, args: Record<string, unknown>) =>
      name === "update_privacy_settings" ? new Promise<RpcAnswer>((resolve) => { finish = resolve; }) : original(name, args));
    await open(services, "/settings/privacy");
    await fireEvent.press(await screen.findByTestId("privacy-save"));
    await fireEvent.press(screen.getByTestId("privacy-showClass"));
    await act(async () => finish(done()));
    expect(screen.getByTestId("privacy-status")).toHaveTextContent(privacyText.dirty);
  });

  it("shows the fixed text when the settings cannot be read", async () => {
    const { services } = fakeServices(() => account(), { ...masterTables, privacy_settings: { data: null, error: { code: "42501" } } });
    await open(services, "/settings/privacy");
    expect(await screen.findByTestId("screen-unavailable")).toHaveTextContent(LOAD_UNAVAILABLE);
  });

  it("opens onboarding for an incomplete profile", async () => {
    const incomplete = fakeServices(() => account({ profile_completed: false }), masterTables);
    const router = await open(incomplete.services, "/settings/privacy");
    await waitFor(() => expect(router.getPathname()).toBe("/onboarding"));
  });
});

describe("profile edit (MOBILE-LIKES-001, docs/43 §4.5)", () => {
  const own = (overrides: Record<string, unknown> = {}) => ({
    profiles: { data: [{ display_name: "架空の学生", gender: "other", bio: "前の文", purposes: ["talk"], hobbies: ["読書"], ...overrides }], error: null },
    profile_photos: { data: [{ id: PHOTO_A, position: 0 }], error: null },
  });

  it("is the first settings link on my page", async () => {
    const router = await open(fakeServices(() => account(), own()).services, "/mypage");
    expect(within(await screen.findByTestId("mypage-link-profile")).getByText(settingsLinks.profile)).toBeTruthy();
    await fireEvent.press(screen.getByTestId("mypage-link-profile"));
    await waitFor(() => expect(router.getPathname()).toBe("/settings/profile"));
    expect(await screen.findByText(profileEditText.title)).toBeTruthy();
  });

  it("shows the own bio and purposes, and saves them with the current name, gender and hobbies", async () => {
    const { services, db } = fakeServices((name) => name === "update_profile" ? done() : account(), own());
    await open(services, "/settings/profile");
    expect(await screen.findByText(onboardingText.purposes)).toBeTruthy();
    expect(screen.getByTestId("purpose-talk").props.accessibilityState).toMatchObject({ checked: true });
    expect(screen.getByTestId("bio").props.value).toBe("前の文");
    expect(screen.queryByText(/モード/)).toBeNull();
    await fireEvent.press(screen.getByTestId("purpose-talk"));
    await fireEvent.press(screen.getByTestId("purpose-partner"));
    await fireEvent.press(screen.getByTestId("purpose-friends"));
    await fireEvent.changeText(screen.getByTestId("bio"), "新しい文");
    await fireEvent.press(screen.getByTestId("profile-edit-save"));
    expect(await screen.findByText(profileEditText.status.ok)).toBeTruthy();
    expect(calls(db, "update_profile")).toEqual([["update_profile", {
      p_display_name: "架空の学生", p_gender: "other", p_bio: "新しい文", p_purposes: ["friends", "partner"], p_hobbies: ["読書"],
    }]]);
    expect(db.queries.filter((q) => q.table === "profiles").at(-1)?.calls).toEqual([["select", "display_name, gender, bio, purposes, hobbies"], ["limit", 2]]);
    expect(calls(db, "set_modes")).toEqual([]);
  });

  it("refuses a bio over 500 characters before any request, and shows a refused save", async () => {
    const { services, db } = fakeServices((name) => name === "update_profile" ? raised("validation") : account(), own());
    await open(services, "/settings/profile");
    await fireEvent.changeText(await screen.findByTestId("bio"), "あ".repeat(501));
    await fireEvent.press(screen.getByTestId("profile-edit-save"));
    expect(await screen.findByText(profileEditText.bio)).toBeTruthy();
    expect(calls(db, "update_profile")).toEqual([]);
    await fireEvent.changeText(screen.getByTestId("bio"), "");
    await fireEvent.press(screen.getByTestId("profile-edit-save"));
    expect(await screen.findByText(profileEditText.status.invalid)).toBeTruthy();
    expect(calls(db, "update_profile")).toHaveLength(1);
  });

  it("shows a hidden bio as empty", async () => {
    await open(fakeServices(() => account(), own({ bio: null, purposes: [] })).services, "/settings/profile");
    expect((await screen.findByTestId("bio")).props.value).toBe("");
    expect(screen.getByTestId("purpose-friends").props.accessibilityState).toMatchObject({ checked: false });
  });

  it("shows the fixed text when the own row cannot be read, and opens onboarding for an incomplete profile", async () => {
    await open(fakeServices(() => account(), own({ purposes: ["romance"] })).services, "/settings/profile");
    expect(await screen.findByText(LOAD_UNAVAILABLE)).toBeTruthy();
    const router = await open(fakeServices(() => account({ profile_completed: false }), { ...own(), ...masterTables }).services, "/settings/profile");
    await waitFor(() => expect(router.getPathname()).toBe("/onboarding"));
  });
});

describe("blocked users (M4)", () => {
  const blocks = (rows: unknown[], reports: unknown[] = []) => (name: string) =>
    name === "my_account" ? account() : name === "list_my_blocks" ? ok(rows) : name === "my_reports" ? ok(reports) : done();
  const row = (overrides: Record<string, unknown> = {}) => ({ blocked_id: TARGET, blocked_name_snapshot: "架空の相手", created_at: "2026-11-17T03:00:00Z", ...overrides });

  it("lists blocked users without their ids and unblocks one", async () => {
    const { services, db } = fakeServices(blocks([row(), row({ blocked_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", blocked_name_snapshot: null })]));
    await open(services, "/settings/blocks");
    expect(await screen.findByText("架空の相手")).toBeTruthy();
    expect(screen.getByText(blocksText.unknown)).toBeTruthy();
    expect(screen.getAllByText("2026/11/17")).toHaveLength(2);
    expect(screen.queryByText(new RegExp(TARGET))).toBeNull();
    await fireEvent.press(screen.getByTestId("unblock-0"));
    expect(screen.getByText(unblockText.note)).toBeTruthy();
    await fireEvent.press(screen.getByTestId("unblock-submit"));
    expect(await screen.findByTestId("unblock-status")).toHaveTextContent(unblockText.done);
    expect(calls(db, "unblock_user")).toEqual([["unblock_user", { p_target: TARGET }]]);
    await fireEvent.press(screen.getByTestId("unblock-close"));
    await waitFor(() => expect(screen.queryByText("架空の相手")).toBeNull());
    expect(screen.getByText(blocksText.unknown)).toBeTruthy();
  });

  it("keeps the row and shows a refused unblock", async () => {
    const { services } = fakeServices((name) => name === "unblock_user" ? refusal("rate_limited") : blocks([row()])(name));
    await open(services, "/settings/blocks");
    await fireEvent.press(await screen.findByTestId("unblock-0"));
    await fireEvent.press(screen.getByTestId("unblock-submit"));
    expect(await screen.findByTestId("unblock-status")).toHaveTextContent(safetyMessages.rate_limited);
    await fireEvent.press(screen.getByTestId("unblock-close"));
    expect(screen.getByText("架空の相手")).toBeTruthy();
  });

  it("shows the empty states", async () => {
    const empty = fakeServices(blocks([]));
    await open(empty.services, "/settings/blocks");
    expect(await screen.findByTestId("blocks-empty")).toHaveTextContent(blocksText.empty);
    expect(screen.getByTestId("reports-empty")).toHaveTextContent(blocksText.noReports);
  });

  it("shows the own reports' states", async () => {
    const reported = fakeServices(blocks([], [{ id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", created_at: "2026-11-16T03:00:00Z", status: "actioned" }]));
    await open(reported.services, "/settings/blocks");
    expect(await screen.findByTestId("report-0")).toHaveTextContent(`2026/11/16 · ${blocksText.labels.actioned}`);
  });

  it("shows the fixed text when the list cannot be read", async () => {
    const { services } = fakeServices((name) => name === "list_my_blocks" ? refusal("made_up") : blocks([])(name));
    await open(services, "/settings/blocks");
    expect(await screen.findByTestId("screen-unavailable")).toHaveTextContent(LOAD_UNAVAILABLE);
  });
});

describe("account (M4)", () => {
  const withState = (state: string, answer: (name: string) => RpcAnswer = () => done()) =>
    (name: string) => name === "my_account" ? account({ account_status: state }) : answer(name);

  it("pauses and resumes", async () => {
    const { services, db } = fakeServices(withState("active"));
    await open(services, "/settings/account");
    expect(await screen.findByText(PAUSE_NOTE)).toBeTruthy();
    expect(screen.getByTestId("account-state")).toHaveTextContent(accountText.active);
    await fireEvent.press(screen.getByTestId("account-toggle"));
    expect(await screen.findByText(accountText.paused)).toBeTruthy();
    expect(screen.getByTestId("account-state")).toHaveTextContent(accountText.deactivated);
    await fireEvent.press(screen.getByTestId("account-toggle"));
    expect(await screen.findByText(accountText.resumed)).toBeTruthy();
    expect(db.rpc.mock.calls.map(([name]) => name).filter((name) => name !== "my_account")).toEqual(["deactivate_account", "reactivate_account"]);
  });

  it("shows a suspended account without the toggle", async () => {
    const suspended = fakeServices(withState("suspended"));
    await open(suspended.services, "/settings/account");
    expect(await screen.findByTestId("account-state")).toHaveTextContent(accountText.suspended);
    expect(screen.queryByTestId("account-toggle")).toBeNull();
  });

  it("shows a stale state's message and reads the state again", async () => {
    const stale = fakeServices(withState("active", () => refusal("invalid_state")));
    await open(stale.services, "/settings/account");
    await fireEvent.press(await screen.findByTestId("account-toggle"));
    expect(await screen.findByText(accountMessages.invalid_state)).toBeTruthy();
    await waitFor(() => expect(calls(stale.db, "my_account").length).toBeGreaterThanOrEqual(2));
  });

  it("asks for the exact confirmation word before deleting", async () => {
    const { services, db } = fakeServices(withState("active"));
    await open(services, "/settings/account");
    await fireEvent.press(await screen.findByTestId("account-delete"));
    expect(screen.getByText(`${accountText.confirmBefore}退会する${accountText.confirmAfter}`)).toBeTruthy();
    await fireEvent.press(screen.getByTestId("delete-privacy"));
    expect(jest.mocked(WebBrowser.openBrowserAsync)).toHaveBeenCalledWith("http://host:3000/privacy");
    expect(screen.getByTestId("delete-submit").props.accessibilityState).toMatchObject({ disabled: true });
    await fireEvent.changeText(screen.getByTestId("delete-word"), "退会");
    await fireEvent.press(screen.getByTestId("delete-submit"));
    expect(calls(db, "request_account_deletion")).toHaveLength(0);
    await fireEvent.press(screen.getByTestId("delete-cancel"));
    expect(screen.queryByTestId("delete-dialog")).toBeNull();
  });

  it("deletes, signs out everywhere, clears the session and shows the completion", async () => {
    const { services, db, auth, clearSession, clearImages } = fakeServices(withState("active"));
    const router = await open(services, "/settings/account");
    await fireEvent.press(await screen.findByTestId("account-delete"));
    await fireEvent.changeText(screen.getByTestId("delete-word"), "退会する");
    await fireEvent.press(screen.getByTestId("delete-submit"));
    expect(await screen.findByTestId("account-deleted")).toHaveTextContent(accountText.deletedBody);
    expect(screen.getByText(accountText.deletedTitle)).toBeTruthy();
    expect(calls(db, "request_account_deletion")).toHaveLength(1);
    await waitFor(() => expect(clearSession).toHaveBeenCalled());
    expect(auth.signOut.mock.calls[0]).toEqual([{ scope: "global" }]);
    expect(clearImages).toHaveBeenCalled();
    expect(router.getPathname()).toBe("/settings/account");
    await fireEvent.press(screen.getByText(accountText.top));
    await waitFor(() => expect(router.getPathname()).toBe("/"));
  });

  it("still clears the session after a deletion when the global revoke fails", async () => {
    const { services, auth, clearSession } = fakeServices(withState("active"), {}, "throw");
    await open(services, "/settings/account");
    await fireEvent.press(await screen.findByTestId("account-delete"));
    await fireEvent.changeText(screen.getByTestId("delete-word"), "退会する");
    await fireEvent.press(screen.getByTestId("delete-submit"));
    expect(await screen.findByTestId("account-deleted")).toBeTruthy();
    await waitFor(() => expect(clearSession).toHaveBeenCalled());
    expect(auth.signOut.mock.calls).toEqual([[{ scope: "global" }], [{ scope: "local" }]]);
  });

  it("shows a refused deletion and keeps the session", async () => {
    const { services, auth } = fakeServices(withState("active", () => ({ data: null, error: { code: "P0001", message: "forbidden" }, status: 400 })));
    await open(services, "/settings/account");
    await fireEvent.press(await screen.findByTestId("account-delete"));
    await fireEvent.changeText(screen.getByTestId("delete-word"), "退会する");
    await fireEvent.press(screen.getByTestId("delete-submit"));
    expect(await screen.findByTestId("delete-status")).toHaveTextContent(accountMessages.forbidden);
    expect(auth.signOut).not.toHaveBeenCalled();
  });

  it("serves nothing to a deleted account", async () => {
    const { services } = fakeServices(() => ok([{ user_id: TARGET, account_status: "deleted", profile_completed: false }]));
    await open(services, "/settings/account");
    expect(await screen.findByTestId("screen-unavailable")).toHaveTextContent(LOAD_UNAVAILABLE);
    expect(screen.queryByTestId("account-delete")).toBeNull();
  });
});
