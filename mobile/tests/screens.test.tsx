import { act, fireEvent, renderRouter, screen, waitFor, within } from "expo-router/testing-library";
import type { AuthAnswer } from "../src/api";
import { AppShell } from "../src/app-shell";
import type { AuthServices } from "../src/auth-context";
import { onboardingText, photoMessages, SESSION_EXPIRED, UNAVAILABLE, verificationText, WELCOME_LINE } from "../src/messages";
import type { PhotoApi } from "../src/photos";
import { authFieldMessages, authMessages, passwordHint, passwordMessages } from "../src/shared";
import RootLayout from "../app/_layout";
import HomeScreen from "../app/home";
import WelcomeScreen from "../app/index";
import MyPageScreen from "../app/mypage";
import OnboardingScreen from "../app/onboarding";
import SignInScreen from "../app/sign-in";
import SignUpScreen from "../app/sign-up";
import VerificationScreen from "../app/verification";
import DiscoverScreen from "../app/discover";
import SearchScreen from "../app/search";
import ProfileScreen from "../app/profiles/[id]";
import LikesScreen from "../app/likes";
import TalkListScreen from "../app/talk/index";
import ChatScreen from "../app/talk/[id]";
import {
  accountRow, CLASS, DEPT, done, fakeSupabase, masterTables, ok, PHOTO_A, PHOTO_B, refusal, SCHOOL, SUBMISSION,
  type RpcAnswer, type TableAnswer,
} from "./fake-supabase";

// FIX-005: an iPhone with a Dynamic Island and a home indicator.
const INSETS = { top: 59, bottom: 34, left: 0, right: 0 };
jest.mock("react-native-safe-area-context", () => ({
  ...jest.requireActual("react-native-safe-area-context/jest/mock").default,
  initialWindowMetrics: { frame: { x: 0, y: 0, width: 402, height: 874 }, insets: { top: 59, bottom: 34, left: 0, right: 0 } },
}));
jest.mock("expo-image", () => {
  const { View } = jest.requireActual("react-native");
  const Image = (props: Record<string, unknown>) => <View {...props} />;
  Image.clearMemoryCache = jest.fn(async () => true);
  return { Image };
});
jest.mock("expo-image-picker", () => ({ launchImageLibraryAsync: jest.fn(async () => ({ canceled: false, assets: [{ uri: "file:///picked.heic" }] })) }));
jest.mock("expo-image-manipulator", () => {
  const image = { width: 1200, height: 900, release: jest.fn(), saveAsync: jest.fn(async () => ({ uri: "file:///cache/out.jpg", width: 1200, height: 900, base64: "QUJD" })) };
  return {
    SaveFormat: { JPEG: "jpeg", WEBP: "webp" },
    ImageManipulator: { manipulate: jest.fn(() => ({ resize: jest.fn(), renderAsync: jest.fn(async () => image) })) },
  };
});

type Listener = (event: string, session: unknown) => void;
type Backend = {
  rpc?: (name: string, args: Record<string, unknown>) => RpcAnswer;
  tables?: Record<string, TableAnswer | (() => TableAnswer)>;
  session?: boolean;
  setSessionError?: boolean;
  upload?: PhotoApi["upload"];
  remove?: PhotoApi["remove"];
};

const jwt = "aaa.bbb.ccc";

function fakeServices(answer: AuthAnswer, options: Backend = {}) {
  let session: unknown = options.session ? { access_token: jwt } : null;
  const listeners: Listener[] = [];
  const emit = () => listeners.forEach((listener) => listener(session ? "SIGNED_IN" : "SIGNED_OUT", session));
  const auth = {
    getSession: jest.fn(async () => ({ data: { session }, error: null })),
    onAuthStateChange: jest.fn((listener: Listener) => {
      listeners.push(listener);
      return { data: { subscription: { unsubscribe: jest.fn() } } };
    }),
    startAutoRefresh: jest.fn(async () => {}),
    stopAutoRefresh: jest.fn(async () => {}),
    setSession: jest.fn(async (value: unknown) => {
      if (options.setSessionError) return { data: { session: null }, error: new Error("refused") };
      session = value;
      emit();
      return { data: { session }, error: null };
    }),
    signOut: jest.fn(async () => {
      session = null;
      emit();
      return { error: null };
    }),
  };
  const db = fakeSupabase(options.rpc ?? (() => ok([accountRow()])), options.tables ?? {});
  const api = { signIn: jest.fn(async () => answer), signUp: jest.fn(async () => answer) };
  const photos = {
    upload: jest.fn(options.upload ?? (async () => "ok" as const)),
    remove: jest.fn(options.remove ?? (async () => "ok" as const)),
    token: jest.fn(async () => jwt),
  };
  const clearImages = jest.fn(async () => true);
  const clearSession = jest.fn(async () => {});
  const services = {
    api, supabase: { auth, rpc: db.rpc, from: db.from }, termsUrl: "http://host:3000/terms", privacyUrl: "http://host:3000/privacy",
    apiBaseUrl: "http://host:3000", photos, clearImages, clearSession,
  };
  return { services: services as unknown as AuthServices, api, auth, db, photos, clearImages, clearSession };
}

async function open(services: AuthServices | null, initialUrl: string) {
  function Layout() {
    return <AppShell services={services} />;
  }
  return renderRouter({
    _layout: Layout, index: WelcomeScreen, "sign-in": SignInScreen, "sign-up": SignUpScreen, home: HomeScreen,
    onboarding: OnboardingScreen, verification: VerificationScreen, mypage: MyPageScreen,
    discover: DiscoverScreen, search: SearchScreen, "profiles/[id]": ProfileScreen, likes: LikesScreen,
    "talk/index": TalkListScreen, "talk/[id]": ChatScreen,
  }, { initialUrl });
}

async function fill(email: string, password: string) {
  await fireEvent.changeText(screen.getByTestId("auth-email"), email);
  await fireEvent.changeText(screen.getByTestId("auth-password"), password);
  await fireEvent.press(screen.getByTestId("auth-submit"));
}

const myPageTables = (photos: string[] = [PHOTO_A]) => ({
  profiles: { data: [{ display_name: "架空の学生" }], error: null },
  profile_photos: { data: photos.map((id, position) => ({ id, position })), error: null },
});

describe("sign-in and sign-up (MOBILE-001)", () => {
  it("shows the welcome screen with sign-up and sign-in", async () => {
    await open(fakeServices({ status: "failed" }).services, "/");
    expect(await screen.findByText("新規登録")).toBeTruthy();
    expect(screen.getByText("ログイン")).toBeTruthy();
    // MOBILE-LIKES-001 (docs/43 Q5): the welcome line of the web.
    expect(screen.getByText(WELCOME_LINE)).toBeTruthy();
    expect(screen.queryByText("恋愛も、友達づくりも。")).toBeNull();
  });

  it("sits the welcome block a little above the centre and keeps it scrollable (UI-015)", async () => {
    await open(fakeServices({ status: "failed" }).services, "/");
    expect(await screen.findByText("新規登録")).toBeTruthy();
    const scroll = screen.getByTestId("welcome-scroll");
    expect(scroll.type).toBe("RCTScrollView");
    expect(scroll.props.contentContainerStyle).toMatchObject({ flexGrow: 1 });
    expect(screen.getByTestId("welcome-spacer-top").props.style).toMatchObject({ flexGrow: 2 });
    expect(screen.getByTestId("welcome-spacer-bottom").props.style).toMatchObject({ flexGrow: 3 });
    const content = within(screen.getByTestId("welcome-content"));
    expect(content.getByText("Campus Link")).toBeTruthy();
    expect(content.getByRole("link", { name: "新規登録" })).toBeTruthy();
    expect(content.getByRole("link", { name: "ログイン" })).toBeTruthy();
    expect(within(screen.getByTestId("safe-frame")).getByTestId("welcome-content")).toBeTruthy();
  });

  it.each(["failed", "rate_limited", "unavailable"] as const)("shows the web's %s message on sign-in", async (status) => {
    const { services, api, auth } = fakeServices({ status });
    await open(services, "/sign-in");
    await fill("student@example.ac.jp", "password123");
    expect(await screen.findByText(authMessages[status])).toBeTruthy();
    expect(api.signIn).toHaveBeenCalledWith("student@example.ac.jp", "password123");
    expect(auth.setSession).not.toHaveBeenCalled();
    expect(screen.getByTestId("auth-password").props.value).toBe("");
  });

  it.each(["/sign-in", "/sign-up"])("hides the password on %s until the toggle shows it, keeping the value (FIX-006)", async (url) => {
    await open(fakeServices({ status: "failed" }).services, url);
    const field = await screen.findByTestId("auth-password");
    expect(field.props.secureTextEntry).toBe(true);
    expect(field.props.autoCapitalize).toBe("none");
    expect(field.props.autoComplete).toBe(url === "/sign-up" ? "new-password" : "current-password");
    expect(field.props.textContentType).toBe(url === "/sign-up" ? "newPassword" : "password");
    await fireEvent.changeText(field, "Fiction-pass-123");
    const toggle = screen.getByTestId("auth-password-toggle");
    expect(toggle.props.accessibilityLabel).toBe("パスワードを表示");
    expect(within(toggle).getByText("表示")).toBeTruthy();
    await fireEvent.press(toggle);
    expect(screen.getByTestId("auth-password").props.secureTextEntry).toBe(false);
    expect(screen.getByTestId("auth-password").props.value).toBe("Fiction-pass-123");
    expect(screen.getByRole("button", { name: "パスワードを隠す" })).toBeTruthy();
    expect(within(screen.getByTestId("auth-password-toggle")).getByText("隠す")).toBeTruthy();
    await fireEvent.press(screen.getByTestId("auth-password-toggle"));
    expect(screen.getByTestId("auth-password").props.secureTextEntry).toBe(true);
    expect(screen.getByTestId("auth-password").props.value).toBe("Fiction-pass-123");
  });

  it("checks the fields before sending, with the web's messages", async () => {
    const { services, api } = fakeServices({ status: "failed" });
    await open(services, "/sign-in");
    await fill("not-an-email", "short");
    expect(await screen.findByText(authFieldMessages.email)).toBeTruthy();
    expect(screen.getByText(authFieldMessages.password)).toBeTruthy();
    expect(screen.getByText(authMessages.invalid)).toBeTruthy();
    expect(api.signIn).not.toHaveBeenCalled();
  });

  it("answers unavailable when the app has no configuration", async () => {
    await open(null, "/sign-in");
    expect(await screen.findByText(authMessages.unavailable)).toBeTruthy();
  });

  it("keeps the session, opens discovery and signs out from my page with the image cache cleared", async () => {
    const session = { access_token: jwt, refresh_token: "r1" };
    const { services, auth, clearImages } = fakeServices({ status: "ok", session }, { tables: myPageTables() });
    const router = await open(services, "/sign-in");
    await fill("student@example.ac.jp", "password123");
    // MOBILE-003: a completed profile lands on discovery (the web's /); this account is not yet verified.
    expect(await screen.findByTestId("discover-not-eligible")).toBeTruthy();
    expect(auth.setSession).toHaveBeenCalledWith(session);
    expect(router.getPathname()).toBe("/discover");
    await fireEvent.press(screen.getByTestId("nav-mypage"));
    expect(await screen.findByTestId("mypage-name")).toBeTruthy();
    expect(router.getPathname()).toBe("/mypage");
    await fireEvent.press(screen.getByTestId("sign-out"));
    await waitFor(() => expect(auth.signOut).toHaveBeenCalledWith({ scope: "local" }));
    expect(clearImages).toHaveBeenCalled();
    expect(await screen.findByText("新規登録")).toBeTruthy();
  });

  it("does not keep a session that supabase-js refuses", async () => {
    const { services, auth } = fakeServices({ status: "ok", session: { access_token: jwt, refresh_token: "r1" } }, { setSessionError: true });
    await open(services, "/sign-in");
    await fill("student@example.ac.jp", "password123");
    expect(await screen.findByText(authMessages.unavailable)).toBeTruthy();
    expect(auth.signOut).toHaveBeenCalledWith({ scope: "local" });
  });

  it("shows the same sent message on sign-up", async () => {
    const { services, api } = fakeServices({ status: "sent" });
    await open(services, "/sign-up");
    expect(screen.getByText("利用規約")).toBeTruthy();
    expect(screen.getByTestId("auth-password-hint").props.children).toBe(passwordHint);
    await fill("student@example.ac.jp", "Campus-link1");
    expect(await screen.findByText(authMessages.sent)).toBeTruthy();
    expect(api.signUp).toHaveBeenCalledWith("student@example.ac.jp", "Campus-link1");
  });

  it.each([
    ["Ab1!", passwordMessages.short],
    ["campus-link1", passwordMessages.uppercase],
    ["CAMPUS-LINK1", passwordMessages.lowercase],
    ["Campus-link", passwordMessages.digit],
    ["Campuslink1", passwordMessages.symbol],
    ["Campus link1!", passwordMessages.characters],
    ["Ｃampus-link1", passwordMessages.characters],
    [`Aa1!${"a".repeat(69)}`, passwordMessages.long],
  ])("refuses the new password %s before sending (FIX-005)", async (password, message) => {
    const { services, api } = fakeServices({ status: "sent" });
    await open(services, "/sign-up");
    await fill("student@example.ac.jp", password);
    expect(await screen.findByText(message)).toBeTruthy();
    expect(screen.getByText(authMessages.invalid)).toBeTruthy();
    expect(api.signUp).not.toHaveBeenCalled();
  });

  it("shows the server's password message when it is a shared one", async () => {
    await open(fakeServices({ status: "invalid", fieldErrors: { password: passwordMessages.rule } }).services, "/sign-up");
    await fill("student@example.ac.jp", "Campus-link1");
    expect(await screen.findByText(passwordMessages.rule)).toBeTruthy();
  });

  it("still signs in with an older-style password and shows no new-password rule (FIX-005)", async () => {
    const { services, api } = fakeServices({ status: "failed" });
    await open(services, "/sign-in");
    expect(screen.queryByTestId("auth-password-hint")).toBeNull();
    await fill("student@example.ac.jp", "password123");
    expect(await screen.findByText(authMessages.failed)).toBeTruthy();
    expect(api.signIn).toHaveBeenCalledWith("student@example.ac.jp", "password123");
  });

  it("shows the sign-up refusals", async () => {
    await open(fakeServices({ status: "rate_limited" }).services, "/sign-up");
    await fill("student@example.ac.jp", "Campus-link1");
    expect(await screen.findByText(authMessages.rate_limited)).toBeTruthy();
  });

  it.each(["/home", "/onboarding", "/verification", "/mypage"])("sends a signed-out user from %s to the welcome screen", async (path) => {
    const router = await open(fakeServices({ status: "failed" }).services, path);
    expect(await screen.findByText("新規登録")).toBeTruthy();
    expect(router.getPathname()).toBe("/");
  });
});

describe("profile gate", () => {
  it("opens onboarding for a profile that is not complete", async () => {
    const { services } = fakeServices({ status: "failed" }, {
      session: true, tables: masterTables,
      rpc: () => ok([accountRow({ has_profile: false, profile_completed: false, account_status: null, birth_date: null })]),
    });
    const router = await open(services, "/");
    expect(await screen.findByText("基本情報")).toBeTruthy();
    expect(router.getPathname()).toBe("/onboarding");
  });

  it("shows a deleted account no screen", async () => {
    const { services } = fakeServices({ status: "failed" }, { session: true, rpc: () => ok([accountRow({ account_status: "deleted", profile_completed: false })]) });
    await open(services, "/home");
    expect(await screen.findByTestId("home-unavailable")).toBeTruthy();
    expect(screen.queryByText("マイページ")).toBeNull();
  });

  it("offers sign-in again when the token is refused", async () => {
    const { services, auth } = fakeServices({ status: "failed" }, { session: true, rpc: () => ({ data: null, error: { code: "PGRST301" }, status: 401 }) });
    const router = await open(services, "/home");
    expect(await screen.findByText(SESSION_EXPIRED)).toBeTruthy();
    await fireEvent.press(screen.getByText("ログインへ"));
    await waitFor(() => expect(router.getPathname()).toBe("/sign-in"));
    expect(auth.signOut).toHaveBeenCalledWith({ scope: "local" });
  });
});

describe("onboarding", () => {
  function newProfile(rpc?: Backend["rpc"]) {
    let completed = false;
    return fakeServices({ status: "failed" }, {
      session: true,
      tables: { ...masterTables, profile_photos: () => ({ data: completed ? [] : [{ id: PHOTO_A, position: 0 }], error: null }) },
      rpc: rpc ?? ((name) => {
        if (name === "my_account") return ok([accountRow({ has_profile: false, profile_completed: false, account_status: null, birth_date: null })]);
        if (name === "complete_profile") { completed = true; return refusal("invalid_state"); }
        return done();
      }),
    });
  }

  async function next() { await fireEvent.press(screen.getByTestId("onboarding-next")); }

  it("checks each step with the web's messages", async () => {
    await open(newProfile().services, "/onboarding");
    await screen.findByText("基本情報");
    await next();
    for (const message of [onboardingText.fields.name, onboardingText.fields.gender, onboardingText.fields.birth, onboardingText.fields.adult]) {
      expect(screen.getByText(message)).toBeTruthy();
    }
    await fireEvent.changeText(screen.getByTestId("onboarding-name"), "架空の学生");
    await fireEvent.press(screen.getByTestId("gender-other"));
    await fireEvent.changeText(screen.getByTestId("birth-year"), "2015");
    await fireEvent.changeText(screen.getByTestId("birth-month"), "1");
    await fireEvent.changeText(screen.getByTestId("birth-day"), "1");
    await fireEvent.press(screen.getByTestId("onboarding-adult"));
    await next();
    // Under 18 on today's JST date.
    expect(screen.getByText(onboardingText.fields.birth)).toBeTruthy();
    expect(screen.queryByText(onboardingText.fields.name)).toBeNull();
  });

  it("saves through the RPCs, registers a photo and completes the profile", async () => {
    const { services, db, photos } = newProfile();
    let completeAnswer: RpcAnswer = refusal("invalid_state");
    db.rpc.mockImplementation(async (name: string) => {
      if (name === "my_account") return ok([accountRow({ has_profile: false, profile_completed: false, account_status: null, birth_date: null })]);
      if (name === "complete_profile") return completeAnswer;
      return done();
    });
    await open(services, "/onboarding");
    await screen.findByText("基本情報");
    await fireEvent.changeText(screen.getByTestId("onboarding-name"), "架空の学生");
    await fireEvent.press(screen.getByTestId("gender-female"));
    await fireEvent.changeText(screen.getByTestId("birth-year"), "2000");
    await fireEvent.changeText(screen.getByTestId("birth-month"), "4");
    await fireEvent.changeText(screen.getByTestId("birth-day"), "1");
    await fireEvent.press(screen.getByTestId("onboarding-adult"));
    await next();
    expect(screen.getByText("所属")).toBeTruthy();
    await next();
    expect(screen.getByText(onboardingText.fields.affiliation)).toBeTruthy();
    await fireEvent.press(screen.getByTestId(`school-${SCHOOL}`));
    await fireEvent.press(screen.getByTestId(`dept-${DEPT}`));
    await fireEvent.press(screen.getByTestId(`class-${CLASS}`));
    await next();
    expect(screen.getByText(onboardingText.photoLater)).toBeTruthy();
    await next();
    // MOBILE-LIKES-001: the optional purposes and the one bio; no mode is asked.
    expect(screen.getByText("目的と自己紹介")).toBeTruthy();
    expect(screen.getByText(onboardingText.purposes)).toBeTruthy();
    expect(screen.getByText(onboardingText.purposesNote)).toBeTruthy();
    expect(screen.queryByTestId("mode-romance")).toBeNull();
    await fireEvent.press(screen.getByTestId("purpose-study"));
    await fireEvent.press(screen.getByTestId("purpose-friends"));
    expect(screen.getByTestId("purpose-friends").props.accessibilityState).toMatchObject({ checked: true });
    await fireEvent.changeText(screen.getByTestId("bio"), "あ".repeat(501));
    expect(screen.getByText("501 / 500文字")).toBeTruthy();
    await next();
    expect(screen.getByText(onboardingText.fields.bio)).toBeTruthy();
    await fireEvent.changeText(screen.getByTestId("bio"), "よろしく");
    await next();
    expect(screen.getByText("入力内容の確認")).toBeTruthy();
    expect(screen.getByText("2000-04-01")).toBeTruthy();
    expect(screen.getByText("架空大学")).toBeTruthy();
    expect(screen.getByTestId("confirm-purposes").props.children).toBe("友達がほしい・勉強仲間がほしい");
    expect(screen.getByTestId("confirm-bio").props.children).toBe("よろしく");
    await next();
    expect(await screen.findByText(onboardingText.saved)).toBeTruthy();
    expect(db.rpc.mock.calls.map(([name]) => name)).toEqual(
      ["my_account", "my_account", "start_onboarding", "set_affiliation", "update_profile", "complete_profile"]);
    expect(db.rpc).toHaveBeenCalledWith("update_profile", {
      p_display_name: "架空の学生", p_gender: "female", p_bio: "よろしく", p_purposes: ["friends", "study"], p_hobbies: [],
    });
    expect(screen.getByTestId("onboarding-complete").props.accessibilityState.disabled).toBe(true);

    await fireEvent.press(screen.getByTestId("photo-add"));
    await waitFor(() => expect(photos.upload).toHaveBeenCalledWith({ uri: "file:///cache/out.jpg", name: "photo.jpg", type: "image/jpeg", size: 3 }));
    const image = await screen.findByTestId("photo-0");
    expect(image.props.cachePolicy).toBe("memory");
    expect(image.props.source).toEqual({ uri: `http://host:3000/api/mobile/photos/${PHOTO_A}`, headers: { Authorization: `Bearer ${jwt}` } });

    completeAnswer = done();
    await fireEvent.press(screen.getByTestId("onboarding-complete"));
    expect(await screen.findByText(onboardingText.created)).toBeTruthy();
    expect(screen.getByText("在学・年齢確認へ")).toBeTruthy();
  });

  it("signs out from the first step to the welcome screen with the session and images cleared (FIX-007)", async () => {
    const { services, auth, clearImages, clearSession } = newProfile();
    const router = await open(services, "/onboarding");
    await screen.findByText("基本情報");
    await fireEvent.press(screen.getByTestId("onboarding-sign-out"));
    await waitFor(() => expect(router.getPathname()).toBe("/"));
    expect(auth.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(clearSession).toHaveBeenCalled();
    expect(clearImages).toHaveBeenCalled();
    expect(await screen.findByText("ログイン")).toBeTruthy();
    expect(screen.getByText("新規登録")).toBeTruthy();
  });

  it("signs out from the photo step after the profile is saved (FIX-007)", async () => {
    const { services, auth, clearSession } = fakeServices({ status: "failed" }, {
      session: true, tables: { ...masterTables, profile_photos: { data: [], error: null } },
      rpc: () => ok([accountRow({ profile_completed: false, has_active_photo: false })]),
    });
    const router = await open(services, "/onboarding");
    expect(await screen.findByText(onboardingText.saved)).toBeTruthy();
    await fireEvent.press(screen.getByTestId("onboarding-sign-out"));
    await waitFor(() => expect(router.getPathname()).toBe("/"));
    expect(auth.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(clearSession).toHaveBeenCalled();
    expect(await screen.findByText("ログイン")).toBeTruthy();
  });

  it("opens a saved profile on its photos and shows a refused upload", async () => {
    const { services } = fakeServices({ status: "failed" }, {
      session: true, tables: { ...masterTables, profile_photos: { data: [], error: null } },
      rpc: () => ok([accountRow({ profile_completed: false, has_active_photo: false })]),
      upload: async () => "rate_limited",
    });
    await open(services, "/onboarding");
    expect(await screen.findByText(onboardingText.saved)).toBeTruthy();
    await fireEvent.press(screen.getByTestId("photo-add"));
    expect(await screen.findByText(photoMessages.rate_limited)).toBeTruthy();
  });

  it("shows the invalid-image message when the picked photo cannot be prepared (FIX-006)", async () => {
    const upload = jest.fn<ReturnType<PhotoApi["upload"]>, Parameters<PhotoApi["upload"]>>(async () => "ok");
    const { services } = fakeServices({ status: "failed" }, {
      session: true, tables: { ...masterTables, profile_photos: { data: [], error: null } },
      rpc: () => ok([accountRow({ profile_completed: false, has_active_photo: false })]),
      upload,
    });
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const manipulator = jest.requireMock("expo-image-manipulator") as { ImageManipulator: { manipulate: jest.Mock } };
    manipulator.ImageManipulator.manipulate.mockImplementationOnce(() => ({ renderAsync: async () => { throw new Error("decode"); } }));
    await open(services, "/onboarding");
    expect(await screen.findByText(onboardingText.saved)).toBeTruthy();
    await fireEvent.press(screen.getByTestId("photo-add"));
    expect(await screen.findByText(photoMessages.invalid)).toBeTruthy();
    expect(upload).not.toHaveBeenCalled();
    expect(warn.mock.calls).toEqual([["photo prepare failed: Error"]]);
    warn.mockRestore();
  });

  it("reports a birth date locked by age verification", async () => {
    const { services } = newProfile((name) => name === "my_account" ? ok([accountRow({ profile_completed: false, birth_date: "1999-01-01" })])
      : name === "update_birth_date" ? refusal("invalid_state") : done());
    // The saved profile opens on its photos; editing returns to the first step.
    await open(services, "/onboarding");
    await screen.findByText(onboardingText.saved);
    await fireEvent.press(screen.getByText("入力内容を修正する"));
    await fireEvent.changeText(screen.getByTestId("onboarding-name"), "架空の学生");
    await fireEvent.press(screen.getByTestId("gender-male"));
    await fireEvent.changeText(screen.getByTestId("birth-year"), "2000");
    await fireEvent.changeText(screen.getByTestId("birth-month"), "04");
    await fireEvent.changeText(screen.getByTestId("birth-day"), "01");
    await fireEvent.press(screen.getByTestId("onboarding-adult"));
    await next();
    await fireEvent.press(screen.getByTestId(`school-${SCHOOL}`));
    await fireEvent.press(screen.getByTestId(`dept-${DEPT}`));
    await fireEvent.press(screen.getByTestId(`class-${CLASS}`));
    await next();
    await next();
    // Nothing chosen and no bio: both are optional.
    await next();
    expect(screen.getByTestId("confirm-purposes").props.children).toBe(onboardingText.noPurposes);
    expect(screen.getByTestId("confirm-bio").props.children).toBe(onboardingText.noBio);
    await next();
    expect(await screen.findByText(onboardingText.status.birth_locked)).toBeTruthy();
  });

  it("answers unavailable when the master cannot be read", async () => {
    const { services } = fakeServices({ status: "failed" }, { session: true, rpc: () => ok([accountRow({ profile_completed: false, has_profile: false })]) });
    await open(services, "/onboarding");
    expect(await screen.findByText(UNAVAILABLE)).toBeTruthy();
  });

  it("sends a completed profile to my page", async () => {
    const router = await open(fakeServices({ status: "failed" }, { session: true, tables: { ...masterTables, ...myPageTables() } }).services, "/onboarding");
    expect(await screen.findByTestId("mypage-name")).toBeTruthy();
    expect(router.getPathname()).toBe("/mypage");
  });
});

describe("verification", () => {
  const submitted = { id: SUBMISSION, kind: "age", status: "submitted", created_at: "2026-11-17T00:00:00Z", decided_at: null, decision_reason: null, valid_until: null };

  it("submits the chosen synthetic samples and shows the new state", async () => {
    let rows: unknown[] = [];
    const { services, db } = fakeServices({ status: "failed" }, {
      session: true, tables: { verification_submissions: () => ({ data: rows, error: null }) },
      rpc: (name) => name === "submit_verification" ? (rows = [submitted], done()) : ok([accountRow()]),
    });
    await open(services, "/verification");
    expect(await screen.findByText(verificationText.notice)).toBeTruthy();
    expect(screen.getByTestId("verification-age-label").props.children).toBe("未提出");
    await fireEvent.press(screen.getByTestId("submit-age"));
    expect(await screen.findByText(verificationText.errors.invalid)).toBeTruthy();
    await fireEvent.press(screen.getByTestId("sample-age-2"));
    await fireEvent.press(screen.getByTestId("submit-age"));
    expect(await screen.findByText("年齢確認を提出しました。")).toBeTruthy();
    expect(db.rpc).toHaveBeenCalledWith("submit_verification", { p_kind: "age", p_document_refs: ["synthetic:sample-2"] });
    await waitFor(() => expect(screen.getByTestId("verification-age-label").props.children).toBe("提出済み"));
    expect(screen.getByTestId("withdraw-age")).toBeTruthy();
  });

  it("shows a decision reason", async () => {
    const rejected = { ...submitted, status: "rejected", decision_reason: "document_unreadable" };
    await open(fakeServices({ status: "failed" }, { session: true, tables: { verification_submissions: { data: [rejected], error: null } } }).services, "/verification");
    expect(await screen.findByText("資料を読み取れませんでした。")).toBeTruthy();
  });

  it("refuses before a profile exists", async () => {

    const none = fakeServices({ status: "failed" }, {
      session: true, tables: { verification_submissions: { data: [], error: null } },
      rpc: () => ok([accountRow({ has_profile: false, profile_completed: false, account_status: null, affiliation_status: null })]),
    });
    await open(none.services, "/verification");
    expect(await screen.findByText(verificationText.needsProfile)).toBeTruthy();
  });

  it("maps a state change on withdraw", async () => {
    const { services } = fakeServices({ status: "failed" }, {
      session: true, tables: { verification_submissions: { data: [submitted], error: null } },
      rpc: (name) => name === "withdraw_verification" ? refusal("not_available") : ok([accountRow()]),
    });
    await open(services, "/verification");
    await fireEvent.press(await screen.findByTestId("withdraw-age"));
    expect(await screen.findByText(verificationText.errors.invalid_state)).toBeTruthy();
  });
});

describe("my page", () => {
  it("shows the name, the verification state and the photos", async () => {
    const { services } = fakeServices({ status: "failed" }, {
      session: true, tables: myPageTables([PHOTO_A, PHOTO_B]),
      rpc: () => ok([accountRow({ age_verified: true, affiliation_status: "pending" })]),
    });
    await open(services, "/mypage");
    expect(await screen.findByText("架空の学生")).toBeTruthy();
    expect(screen.getByTestId("mypage-age").props.children).toBe("確認済み");
    expect(screen.getByTestId("mypage-affiliation").props.children).toBe("審査中");
    expect(screen.getByText("確認が済むと、探す・いいね・トークを利用できます。")).toBeTruthy();
    expect(await screen.findAllByTestId("photo-item")).toHaveLength(2);
  });

  it("refuses to remove the last photo with the web's message", async () => {
    const { services, photos } = fakeServices({ status: "failed" }, { session: true, tables: myPageTables(), remove: async () => "last_photo" });
    await open(services, "/mypage");
    await fireEvent.press(await screen.findByTestId("photo-remove-0"));
    expect(await screen.findByText(photoMessages.last_photo)).toBeTruthy();
    expect(photos.remove).toHaveBeenCalledWith(PHOTO_A);
    expect(screen.getAllByTestId("photo-item")).toHaveLength(1);
  });

  it("reorders photos with reorder_photos", async () => {
    const { services, db } = fakeServices({ status: "failed" }, {
      session: true, tables: myPageTables([PHOTO_A, PHOTO_B]), rpc: (name) => name === "reorder_photos" ? done() : ok([accountRow()]),
    });
    await open(services, "/mypage");
    await screen.findAllByTestId("photo-item");
    await act(async () => { await fireEvent.press(screen.getAllByText("前へ")[1]); });
    await waitFor(() => expect(db.rpc).toHaveBeenCalledWith("reorder_photos", { p_ids: [PHOTO_B, PHOTO_A] }));
    await waitFor(() => expect(screen.getByTestId("photo-0").props.source.uri).toContain(PHOTO_B));
  });

  it("sends an unfinished profile to onboarding", async () => {
    const router = await open(fakeServices({ status: "failed" }, {
      session: true, tables: masterTables, rpc: () => ok([accountRow({ profile_completed: false, has_profile: false })]),
    }).services, "/mypage");
    expect(await screen.findByText("基本情報")).toBeTruthy();
    expect(router.getPathname()).toBe("/onboarding");
  });
});

describe("safe area (FIX-005)", () => {
  function expectInsideSafeArea(testID: string) {
    const frame = screen.getByTestId("safe-frame");
    expect(frame.props.style).toMatchObject({ paddingTop: INSETS.top, paddingBottom: INSETS.bottom, paddingLeft: INSETS.left, paddingRight: INSETS.right });
    expect(within(frame).getByTestId(testID)).toBeTruthy();
  }

  it("keeps the real root layout's screens below the status bar and above the home indicator", async () => {
    await renderRouter({ _layout: RootLayout, index: WelcomeScreen }, { initialUrl: "/" });
    expect(await screen.findByText("新規登録")).toBeTruthy();
    expect(screen.getByTestId("safe-frame").props.style).toMatchObject({ paddingTop: INSETS.top, paddingBottom: INSETS.bottom });
    expect(within(screen.getByTestId("safe-frame")).getByText("新規登録")).toBeTruthy();
  });

  it.each(["/sign-in", "/sign-up"])("puts %s inside the safe area", async (path) => {
    await open(fakeServices({ status: "failed" }).services, path);
    expect(await screen.findByTestId("auth-email")).toBeTruthy();
    expectInsideSafeArea("auth-submit");
  });

  it("puts the signed-in screens and their tab bar inside the safe area", async () => {
    const { services } = fakeServices({ status: "failed" }, { session: true, tables: myPageTables() });
    await open(services, "/mypage");
    expect(await screen.findByTestId("mypage-name")).toBeTruthy();
    expectInsideSafeArea("nav-mypage");
    await fireEvent.press(screen.getByTestId("nav-discover"));
    expect(await screen.findByTestId("discover-not-eligible")).toBeTruthy();
    expectInsideSafeArea("nav-discover");
  });
});
