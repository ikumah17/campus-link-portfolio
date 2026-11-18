import { act, fireEvent, renderRouter, screen, waitFor, within } from "expo-router/testing-library";
import { StyleSheet } from "react-native";
import { AppShell } from "../src/app-shell";
import type { AuthServices } from "../src/auth-context";
import {
  chatText, discoverText, HIDDEN_CONTENT_TEXT, likeMessages, likesText, likeText, LIKES_MORE, LOAD_UNAVAILABLE, PROFILE_UNAVAILABLE, profileText,
  safetyText, searchText, SESSION_EXPIRED, talkListText,
} from "../src/messages";
import DiscoverScreen from "../app/discover";
import HomeScreen from "../app/home";
import WelcomeScreen from "../app/index";
import MyPageScreen from "../app/mypage";
import OnboardingScreen from "../app/onboarding";
import ProfileScreen from "../app/profiles/[id]";
import LikesScreen from "../app/likes";
import SearchScreen from "../app/search";
import ChatScreen from "../app/talk/[id]";
import TalkListScreen from "../app/talk/index";
import VerificationScreen from "../app/verification";
import {
  accountRow, CONV, conversationRow, done, fakeSupabase, likeRow, likeStateRow, masterTables, messageRow, ok, PHOTO_A, profileRow, raised, refusal, SCHOOL,
  TARGET, USER, type RpcAnswer, type TableAnswer,
} from "./fake-supabase";

// MOBILE-003: the states of the discovery, profile, talk and chat screens; MOBILE-LIKES-001: the likes screen and the like
// buttons replace the requests, and no mode is left.
// FIX-005: an iPhone with a Dynamic Island and a home indicator.
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

const jwt = "aaa.bbb.ccc";
type Channel = { name: string; filter: Record<string, unknown>; insert: () => void; status: (value: string) => void };

function fakeServices(rpc: (name: string, args: Record<string, unknown>) => RpcAnswer, tables: Record<string, TableAnswer> = masterTables) {
  const auth = {
    getSession: jest.fn(async () => ({ data: { session: { access_token: jwt } }, error: null })),
    onAuthStateChange: jest.fn(() => ({ data: { subscription: { unsubscribe: jest.fn() } } })),
    startAutoRefresh: jest.fn(async () => {}),
    stopAutoRefresh: jest.fn(async () => {}),
    signOut: jest.fn(async () => ({ error: null })),
  };
  const db = fakeSupabase(rpc, tables);
  const channels: Channel[] = [];
  const realtime = { setAuth: jest.fn(async () => {}) };
  const channel = jest.fn((name: string) => {
    const record: Channel = { name, filter: {}, insert: () => {}, status: () => {} };
    const builder = {
      on: (_type: string, filter: Record<string, unknown>, callback: () => void) => { record.filter = filter; record.insert = callback; return builder; },
      subscribe: (callback: (value: string) => void) => { record.status = callback; channels.push(record); return builder; },
    };
    return builder;
  });
  const removeChannel = jest.fn(async () => "ok");
  const clearImages = jest.fn(async () => true);
  const services = {
    api: { signIn: jest.fn(), signUp: jest.fn() }, supabase: { auth, rpc: db.rpc, from: db.from, realtime, channel, removeChannel },
    termsUrl: "http://host:3000/terms", privacyUrl: "http://host:3000/privacy", apiBaseUrl: "http://host:3000",
    photos: { upload: jest.fn(), remove: jest.fn(), token: jest.fn(async () => jwt) }, clearImages,
  };
  return { services: services as unknown as AuthServices, db, channels, channel, removeChannel, realtime, clearImages };
}

async function open(services: AuthServices, initialUrl: string) {
  function Layout() {
    return <AppShell services={services} />;
  }
  return renderRouter({
    _layout: Layout, index: WelcomeScreen, home: HomeScreen, onboarding: OnboardingScreen, verification: VerificationScreen, mypage: MyPageScreen,
    discover: DiscoverScreen, search: SearchScreen, "profiles/[id]": ProfileScreen, likes: LikesScreen,
    "talk/index": TalkListScreen, "talk/[id]": ChatScreen,
  }, { initialUrl });
}

const eligible = () => ok([accountRow({ eligible: true, age_verified: true, affiliation_status: "confirmed", affiliation_confirmed: true })]);
const calls = (db: ReturnType<typeof fakeSupabase>, name: string) => db.rpc.mock.calls.filter(([called]) => called === name);

describe("discovery (M2)", () => {
  const discover = (profiles: unknown[] = [profileRow()]) => fakeServices((name) => name === "my_account" ? eligible() : ok(profiles));

  it("shows a completed profile's start as discovery, and the way to verification when not yet eligible", async () => {
    const { services } = fakeServices(() => ok([accountRow()]));
    const router = await open(services, "/home");
    expect(await screen.findByText(discoverText.notEligible)).toBeTruthy();
    expect(router.getPathname()).toBe("/discover");
    await fireEvent.press(screen.getByText(discoverText.toVerification));
    await waitFor(() => expect(router.getPathname()).toBe("/verification"));
  });

  it("lists profiles with their delivered photo in the memory cache only", async () => {
    const { services, db } = discover();
    await open(services, "/discover");
    expect(await screen.findByText(/^架空の相手 /)).toBeTruthy();
    expect(screen.getByText("女性")).toBeTruthy();
    expect(screen.getByText("架空大学")).toBeTruthy();
    expect(screen.getByText("読書")).toBeTruthy();
    expect(calls(db, "discover_profiles")[0][1]).toEqual({
      p_min_age: null, p_max_age: null, p_genders: null, p_school_ids: null, p_after: null, p_limit: 20,
    });
    const photo = await screen.findByLabelText("架空の相手の写真");
    expect(photo.props.source).toEqual({ uri: `http://host:3000/api/mobile/photos/${PHOTO_A}`, headers: { Authorization: `Bearer ${jwt}` } });
    expect(photo.props.cachePolicy).toBe("memory");
  });

  it("is one list: no mode tabs, an old mode param is ignored, and a profile opens without one", async () => {
    const { services, db } = discover();
    const router = await open(services, "/discover?mode=friends");
    await screen.findByText(/^架空の相手 /);
    expect(screen.queryByTestId("discover-mode-romance")).toBeNull();
    expect(screen.queryByTestId("discover-mode-friends")).toBeNull();
    expect(calls(db, "discover_profiles")[0][1]).not.toHaveProperty("p_mode");
    await fireEvent.press(await screen.findByTestId(`discover-view-${TARGET}`));
    await waitFor(() => expect(router.getPathname()).toBe(`/profiles/${TARGET}`));
    expect(router.getSearchParams()).not.toHaveProperty("mode");
    await waitFor(() => expect(calls(db, "get_profile")[0][1]).toEqual({ p_target: TARGET }));
  });

  it("shows the purposes on a card, and none when there are none", async () => {
    await open(discover([profileRow(), profileRow({ user_id: USER, display_name: "目的なし", purposes: [] })]).services, "/discover");
    expect(await screen.findByTestId(`discover-purposes-${TARGET}`)).toBeTruthy();
    expect(screen.getByText("友達がほしい・趣味仲間がほしい")).toBeTruthy();
    expect(screen.queryByTestId(`discover-purposes-${USER}`)).toBeNull();
  });

  it("likes from a card with like_user and takes it back (docs/43 Q8)", async () => {
    const { services, db } = fakeServices((name) => name === "my_account" ? eligible() : name === "discover_profiles" ? ok([profileRow()]) : done());
    await open(services, "/discover");
    const button = await screen.findByTestId(`discover-like-${TARGET}-button`);
    expect(button.props.accessibilityLabel).toBe(`架空の相手${likeText.likeLabel}`);
    await fireEvent.press(button);
    expect(await screen.findByText(likeText.liked)).toBeTruthy();
    expect(calls(db, "like_user")[0][1]).toEqual({ p_target: TARGET });
    expect(screen.getByText(likeText.iLiked)).toBeTruthy();
    await fireEvent.press(screen.getByTestId(`discover-like-${TARGET}-unlike`));
    expect(await screen.findByText(likeText.unliked)).toBeTruthy();
    expect(calls(db, "unlike_user")[0][1]).toEqual({ p_target: TARGET });
    expect(screen.getByTestId(`discover-like-${TARGET}-button`)).toBeTruthy();
  });

  it("opens the new conversation after a match from a card", async () => {
    const { services } = fakeServices((name) => name === "my_account" ? eligible() : name === "discover_profiles" ? ok([profileRow()])
      : name === "like_user" ? { data: { ok: true, code: "ok", ref: CONV }, error: null, status: 200 } : ok([conversationRow()]));
    const router = await open(services, "/discover");
    await fireEvent.press(await screen.findByTestId(`discover-like-${TARGET}-button`));
    expect(await screen.findByText(likeText.matched)).toBeTruthy();
    await fireEvent.press(screen.getByTestId(`discover-like-${TARGET}-talk`));
    await waitFor(() => expect(router.getPathname()).toBe(`/talk/${CONV}`));
  });

  it("opens the likes from the tab bar", async () => {
    const router = await open(discover().services, "/discover");
    await screen.findByText(/^架空の相手 /);
    expect(within(screen.getByTestId("nav-likes")).getByText("いいね")).toBeTruthy();
    expect(screen.queryByText("申請")).toBeNull();
    await fireEvent.press(screen.getByTestId("nav-likes"));
    await waitFor(() => expect(router.getPathname()).toBe("/likes"));
  });

  it("shows the empty state without any count", async () => {
    await open(discover([]).services, "/discover");
    expect(await screen.findByText(discoverText.empty)).toBeTruthy();
    expect(screen.queryByText(discoverText.fromStart)).toBeNull();
  });

  it("pages by the last id and offers the first page again", async () => {
    const rows = Array.from({ length: 20 }, (_, i) => profileRow({ user_id: `88888888-8888-4888-8888-${String(i).padStart(12, "0")}`, display_name: `相手${i}` }));
    let page = 0;
    const { services, db } = fakeServices((name) => name === "my_account" ? eligible() : ok(page++ === 0 ? rows : []));
    await open(services, "/discover");
    await fireEvent.press(await screen.findByTestId("discover-next"));
    expect(await screen.findByText(discoverText.empty)).toBeTruthy();
    expect(calls(db, "discover_profiles")[1][1]).toMatchObject({ p_after: rows[19].user_id });
    expect(screen.getByText(discoverText.fromStart)).toBeTruthy();
  });

  it("applies the conditions from the search screen and clears them", async () => {
    const { services, db } = discover();
    const router = await open(services, "/discover");
    await fireEvent.press(await screen.findByTestId("discover-conditions"));
    expect(await screen.findByText(searchText.privacy)).toBeTruthy();
    await fireEvent.changeText(screen.getByTestId("search-min"), "30");
    await fireEvent.changeText(screen.getByTestId("search-max"), "20");
    await fireEvent.press(screen.getByTestId("search-submit"));
    expect(await screen.findByText(searchText.ageOrder)).toBeTruthy();
    await fireEvent.changeText(screen.getByTestId("search-min"), "17");
    await fireEvent.press(screen.getByTestId("search-submit"));
    expect(await screen.findByText(searchText.ageInvalid)).toBeTruthy();
    await fireEvent.changeText(screen.getByTestId("search-min"), "20");
    await fireEvent.changeText(screen.getByTestId("search-max"), "25");
    await fireEvent.press(screen.getByTestId("search-gender-female"));
    await fireEvent.press(screen.getByTestId(`search-school-${SCHOOL}`));
    await fireEvent.press(screen.getByTestId("search-submit"));
    expect(await screen.findByText("20〜25歳")).toBeTruthy();
    expect(router.getPathname()).toBe("/discover");
    expect(calls(db, "discover_profiles").at(-1)?.[1]).toMatchObject({ p_min_age: 20, p_max_age: 25, p_genders: ["female"], p_school_ids: [SCHOOL] });
    await fireEvent.press(screen.getByTestId("discover-clear"));
    await waitFor(() => expect(calls(db, "discover_profiles").at(-1)?.[1]).toMatchObject({ p_min_age: null, p_genders: null, p_school_ids: null }));
    expect(screen.queryByText("20〜25歳")).toBeNull();
  });

  it("sends an incomplete profile to onboarding and offers sign-in again for a refused token", async () => {
    const incomplete = fakeServices(() => ok([accountRow({ profile_completed: false, has_profile: false })]));
    const router = await open(incomplete.services, "/discover");
    await waitFor(() => expect(router.getPathname()).toBe("/onboarding"));
    await open(fakeServices(() => ({ data: null, error: { code: "PGRST301" }, status: 401 })).services, "/discover");
    expect(await screen.findByText(SESSION_EXPIRED)).toBeTruthy();
  });
});

describe("profile detail (M2–M3)", () => {
  function detail(options: { profile?: unknown[]; state?: RpcAnswer; like?: RpcAnswer; block?: RpcAnswer; report?: RpcAnswer } = {}) {
    return fakeServices((name) => {
      if (name === "my_account") return eligible();
      if (name === "get_profile") return ok(options.profile ?? [profileRow({ photo_ids: [PHOTO_A, TARGET] })]);
      if (name === "get_like_state") return options.state ?? ok([likeStateRow()]);
      if (name === "like_user" || name === "unlike_user") return options.like ?? done();
      if (name === "block_user") return options.block ?? done();
      if (name === "submit_report") return options.report ?? done();
      return ok([]);
    });
  }

  it("shows the profile with every photo and the web's rows", async () => {
    await open(detail().services, `/profiles/${TARGET}`);
    expect(await screen.findByText(/^架空の相手 /)).toBeTruthy();
    expect(screen.queryByText(/モード/)).toBeNull();
    expect(screen.getByText("よろしくお願いします。")).toBeTruthy();
    expect(within(screen.getByTestId("profile-row-purposes")).getByText(profileText.rows.purposes)).toBeTruthy();
    expect(screen.getByText("友達がほしい・趣味仲間がほしい")).toBeTruthy();
    expect(await screen.findByLabelText("架空の相手の写真 2")).toBeTruthy();
  });

  it("leaves out empty rows", async () => {
    await open(detail({ profile: [profileRow({ bio: null, purposes: [], hobbies: [] })] }).services, `/profiles/${TARGET}`);
    expect(await screen.findByText(/^架空の相手 /)).toBeTruthy();
    for (const key of ["bio", "hobbies", "purposes"]) expect(screen.queryByTestId(`profile-row-${key}`)).toBeNull();
  });

  it.each([["an unviewable profile", `/profiles/${TARGET}`], ["a malformed id", "/profiles/not-a-uuid"]])("gives %s the one not-viewable screen", async (_label, path) => {
    const { services } = detail({ profile: [] });
    await open(services, path);
    expect(await screen.findByText(PROFILE_UNAVAILABLE)).toBeTruthy();
    expect(screen.queryByText(/^架空の相手 /)).toBeNull();
  });

  it("answers the web's text when the profile cannot be read", async () => {
    await open(detail({ profile: [{ broken: true }] }).services, `/profiles/${TARGET}`);
    expect(await screen.findByText(LOAD_UNAVAILABLE)).toBeTruthy();
  });

  it("starts from いいね, likes with like_user and takes it back", async () => {
    const { services, db } = detail();
    await open(services, `/profiles/${TARGET}`);
    const button = await screen.findByTestId("like-button");
    expect(calls(db, "get_like_state")[0][1]).toEqual({ p_target: TARGET });
    expect(button.props.accessibilityLabel).toBe(`架空の相手${likeText.likeLabel}`);
    await fireEvent.press(button);
    expect(await screen.findByText(likeText.liked)).toBeTruthy();
    expect(calls(db, "like_user")[0][1]).toEqual({ p_target: TARGET });
    expect(screen.getByText(likeText.iLiked)).toBeTruthy();
    expect(screen.getByTestId("like-unlike").props.accessibilityLabel).toBe(`架空の相手${likeText.unlikeLabel}`);
    await fireEvent.press(screen.getByTestId("like-unlike"));
    expect(await screen.findByText(likeText.unliked)).toBeTruthy();
    expect(calls(db, "unlike_user")[0][1]).toEqual({ p_target: TARGET });
    expect(screen.getByTestId("like-button")).toBeTruthy();
  });

  it("shows いいね済み with 取り消す when the user already liked", async () => {
    await open(detail({ state: ok([likeStateRow({ i_liked: true })]) }).services, `/profiles/${TARGET}`);
    expect(await screen.findByText(likeText.iLiked)).toBeTruthy();
    expect(screen.getByTestId("like-unlike")).toBeTruthy();
    expect(screen.queryByTestId("like-button")).toBeNull();
  });

  it("shows the other person's like and makes a match with いいねを返す", async () => {
    const { services, db } = detail({ state: ok([likeStateRow({ liked_me: true })]), like: { data: { ok: true, code: "ok", ref: CONV }, error: null, status: 200 } });
    const router = await open(services, `/profiles/${TARGET}`);
    expect(await screen.findByText(likeText.likedMe)).toBeTruthy();
    expect(screen.getByTestId("like-back").props.accessibilityLabel).toBe(`架空の相手${likeText.likeBackLabel}`);
    await fireEvent.press(screen.getByTestId("like-back"));
    expect(await screen.findByText(likeText.matched)).toBeTruthy();
    expect(calls(db, "like_user")[0][1]).toEqual({ p_target: TARGET });
    await fireEvent.press(screen.getByTestId("like-talk"));
    await waitFor(() => expect(router.getPathname()).toBe(`/talk/${CONV}`));
  });

  it("shows トークを開く for a match", async () => {
    const router = await open(detail({ state: ok([likeStateRow({ conversation_id: CONV })]) }).services, `/profiles/${TARGET}`);
    expect(await screen.findByText(likeText.openTalk)).toBeTruthy();
    expect(screen.queryByTestId("like-button")).toBeNull();
    await fireEvent.press(screen.getByTestId("like-talk"));
    await waitFor(() => expect(router.getPathname()).toBe(`/talk/${CONV}`));
  });

  it("starts from いいね when the like state cannot be read", async () => {
    await open(detail({ state: raised("forbidden") }).services, `/profiles/${TARGET}`);
    expect(await screen.findByTestId("like-button")).toBeTruthy();
    expect(screen.getByText(/^架空の相手 /)).toBeTruthy();
  });

  it.each([
    ["not_available", refusal("not_available")], ["rate_limited", refusal("rate_limited")], ["unavailable", raised("forbidden")],
  ] as const)("shows the web's %s answer and keeps the button", async (code, answer) => {
    await open(detail({ like: answer }).services, `/profiles/${TARGET}`);
    await fireEvent.press(await screen.findByTestId("like-button"));
    expect(await screen.findByText(likeMessages[code])).toBeTruthy();
    expect(screen.getByTestId("like-button")).toBeTruthy();
  });

  it("answers already_connected with the way to the talk list", async () => {
    const router = await open(detail({ like: refusal("already_connected") }).services, `/profiles/${TARGET}`);
    await fireEvent.press(await screen.findByTestId("like-button"));
    expect(await screen.findByText(likeMessages.already_connected)).toBeTruthy();
    await fireEvent.press(screen.getByTestId("like-talk"));
    await waitFor(() => expect(router.getPathname()).toBe("/talk"));
  });

  it("keeps the profile, its tab bar and its dialog inside the safe area (FIX-005)", async () => {
    await open(detail().services, `/profiles/${TARGET}`);
    await fireEvent.press(await screen.findByTestId("safety-block"));
    expect(await screen.findByTestId("safety-dialog")).toBeTruthy();
    expect(screen.getByTestId("safe-frame").props.style).toMatchObject({ paddingTop: 59, paddingBottom: 34 });
    expect(within(screen.getByTestId("safe-frame")).getByTestId("nav-discover")).toBeTruthy();
    // The modal covers the whole screen, so its backdrop adds the insets to its own 16-point margin.
    expect(StyleSheet.flatten(screen.getByTestId("safety-dialog-backdrop").props.style)).toMatchObject({ paddingTop: 75, paddingBottom: 50, paddingLeft: 16, paddingRight: 16 });
  });


  it("blocks, clears the image cache and returns to the list", async () => {
    const { services, db, clearImages } = detail();
    const router = await open(services, `/profiles/${TARGET}`);
    await fireEvent.press(await screen.findByTestId("safety-block"));
    expect(await screen.findByText(`架空の相手${safetyText.blockTitle}`)).toBeTruthy();
    expect(screen.getByText(safetyText.blockNote)).toBeTruthy();
    await fireEvent.press(screen.getByTestId("safety-submit"));
    expect(await screen.findByText(safetyText.blocked)).toBeTruthy();
    expect(calls(db, "block_user")[0][1]).toEqual({ p_target: TARGET });
    expect(clearImages).toHaveBeenCalled();
    await fireEvent.press(screen.getByText(safetyText.close));
    await waitFor(() => expect(router.getPathname()).toBe("/discover"));
  });

  it("reports with a reason and a detail", async () => {
    const { services, db } = detail();
    await open(services, `/profiles/${TARGET}`);
    await fireEvent.press(await screen.findByTestId("safety-report"));
    await fireEvent.press(await screen.findByTestId("reason-spam"));
    await fireEvent.changeText(screen.getByTestId("report-detail"), "詳細");
    await fireEvent.press(screen.getByTestId("safety-submit"));
    expect(await screen.findByText(safetyText.reported)).toBeTruthy();
    expect(calls(db, "submit_report")[0][1]).toEqual({ p_target: TARGET, p_context: "profile", p_reason: "spam", p_detail: "詳細", p_request_id: null, p_message_id: null });
  });

  it("shows the web's refusal of a report", async () => {
    await open(detail({ report: refusal("rate_limited") }).services, `/profiles/${TARGET}`);
    await fireEvent.press(await screen.findByTestId("safety-report"));
    await fireEvent.press(await screen.findByTestId("safety-submit"));
    expect(await screen.findByText("しばらくしてから再度お試しください。")).toBeTruthy();
  });
});

describe("likes (MOBILE-LIKES-001)", () => {
  const sentRow = likeRow({ counterpart_id: USER }, { user_id: USER, display_name: "いいねした相手", purposes: [] });
  function likes(options: { received?: unknown[] | (() => unknown[]); sent?: unknown[]; like?: RpcAnswer; other?: RpcAnswer } = {}) {
    return fakeServices((name, args) => {
      if (name === "my_account") return eligible();
      if (name === "list_my_likes") {
        const list = args.p_direction === "received" ? options.received ?? [likeRow()] : options.sent ?? [sentRow];
        return ok(typeof list === "function" ? list() : list);
      }
      if (name === "like_user" || name === "unlike_user") return options.like ?? done();
      return options.other ?? done();
    });
  }

  it("shows the received list first with its card, and the sent list on its tab", async () => {
    const { services, db } = likes();
    await open(services, "/likes");
    expect(await screen.findByText(likesText.description)).toBeTruthy();
    expect(screen.getByText(/^架空の相手 /)).toBeTruthy();
    expect(screen.getByText("架空大学")).toBeTruthy();
    expect(screen.getByText("友達がほしい・趣味仲間がほしい")).toBeTruthy();
    expect(screen.getByTestId(`like-back-${TARGET}`).props.accessibilityLabel).toBe(`架空の相手${likeText.likeBackLabel}`);
    expect(screen.getByTestId("likes-tab-0").props.accessibilityState).toMatchObject({ selected: true });
    expect(calls(db, "list_my_likes").map(([, args]) => args)).toEqual([
      { p_direction: "received", p_before_at: null, p_before_id: null, p_limit: 50 },
      { p_direction: "sent", p_before_at: null, p_before_id: null, p_limit: 50 },
    ]);
    await fireEvent.press(screen.getByTestId("likes-tab-1"));
    expect(await screen.findByText(/^いいねした相手 /)).toBeTruthy();
    expect(screen.queryByTestId(`like-purposes-${USER}`)).toBeNull();
    expect(screen.getByTestId(`like-unlike-${USER}`)).toBeTruthy();
    expect(screen.queryByText(/^架空の相手 /)).toBeNull();
  });

  it("likes back into a match, takes the row out and opens the talk", async () => {
    const { services, db } = likes({ like: { data: { ok: true, code: "ok", ref: CONV }, error: null, status: 200 }, other: ok([conversationRow()]) });
    const router = await open(services, "/likes");
    await fireEvent.press(await screen.findByTestId(`like-back-${TARGET}`));
    expect(await screen.findByText(likeText.matched)).toBeTruthy();
    expect(calls(db, "like_user")[0][1]).toEqual({ p_target: TARGET });
    expect(screen.getByText(likesText.emptyReceived)).toBeTruthy();
    await fireEvent.press(screen.getByTestId("likes-open-talk"));
    await waitFor(() => expect(router.getPathname()).toBe(`/talk/${CONV}`));
  });

  it("likes back without a match, and keeps a refused row", async () => {
    await open(likes().services, "/likes");
    await fireEvent.press(await screen.findByTestId(`like-back-${TARGET}`));
    expect(await screen.findByText(likeText.liked)).toBeTruthy();
    expect(screen.queryByTestId("likes-open-talk")).toBeNull();
    await open(likes({ like: refusal("rate_limited") }).services, "/likes");
    await fireEvent.press(await screen.findByTestId(`like-back-${TARGET}`));
    expect(await screen.findByText(likeMessages.rate_limited)).toBeTruthy();
    expect(screen.getByTestId(`like-back-${TARGET}`)).toBeTruthy();
  });

  it("answers already_connected with the way to the talk list", async () => {
    const router = await open(likes({ like: refusal("already_connected"), other: ok([]) }).services, "/likes");
    await fireEvent.press(await screen.findByTestId(`like-back-${TARGET}`));
    expect(await screen.findByText(likeMessages.already_connected)).toBeTruthy();
    await fireEvent.press(screen.getByTestId("likes-open-talk"));
    await waitFor(() => expect(router.getPathname()).toBe("/talk"));
  });

  it("takes back a sent like and then shows the way to discovery", async () => {
    const { services, db } = likes({ other: ok([]) });
    const router = await open(services, "/likes");
    await fireEvent.press(await screen.findByTestId("likes-tab-1"));
    await fireEvent.press(await screen.findByTestId(`like-unlike-${USER}`));
    expect(await screen.findByText(likeText.unliked)).toBeTruthy();
    expect(calls(db, "unlike_user")[0][1]).toEqual({ p_target: USER });
    expect(screen.getByText(likesText.emptySent)).toBeTruthy();
    await fireEvent.press(screen.getByTestId("likes-to-discover"));
    await waitFor(() => expect(router.getPathname()).toBe("/discover"));
  });

  it("shows both empty states", async () => {
    await open(likes({ received: [], sent: [] }).services, "/likes");
    expect(await screen.findByText(likesText.emptyReceived)).toBeTruthy();
    expect(screen.queryByTestId("likes-to-discover")).toBeNull();
    await fireEvent.press(screen.getByTestId("likes-tab-1"));
    expect(await screen.findByText(likesText.emptySent)).toBeTruthy();
    expect(within(screen.getByTestId("likes-to-discover")).getByText(likesText.toDiscover)).toBeTruthy();
  });

  it("adds the next page of the shown list with さらに表示", async () => {
    const first = Array.from({ length: 50 }, (_, i) => {
      const id = `88888888-8888-4888-8888-${String(i).padStart(12, "0")}`;
      return likeRow({ counterpart_id: id, liked_at: `2026-11-17T03:00:${String(i).padStart(2, "0")}Z` }, { user_id: id, display_name: `相手${i}` });
    });
    let page = 0;
    const { services, db } = likes({ received: () => page++ === 0 ? first : [likeRow({}, { display_name: "次の相手" })] });
    await open(services, "/likes");
    expect(await screen.findByText(/^相手49 /)).toBeTruthy();
    await fireEvent.press(screen.getByText(LIKES_MORE));
    expect(await screen.findByText(/^次の相手 /)).toBeTruthy();
    expect(calls(db, "list_my_likes").at(-1)?.[1]).toEqual({ p_direction: "received", p_before_at: first[49].liked_at, p_before_id: first[49].counterpart_id, p_limit: 50 });
    expect(screen.getByText(/^相手0 /)).toBeTruthy();
    expect(screen.queryByTestId("likes-more")).toBeNull();
  });

  it("opens a row's profile", async () => {
    const router = await open(likes({ other: ok([]) }).services, "/likes");
    await fireEvent.press(await screen.findByTestId(`like-profile-${TARGET}`));
    await waitFor(() => expect(router.getPathname()).toBe(`/profiles/${TARGET}`));
  });

  it("reports and blocks a row in the profile context; a blocked person leaves the list", async () => {
    const { services, db } = likes();
    await open(services, "/likes");
    await fireEvent.press(await screen.findByTestId("safety-report"));
    await fireEvent.press(await screen.findByTestId("safety-submit"));
    expect(await screen.findByText(safetyText.reported)).toBeTruthy();
    expect(calls(db, "submit_report")[0][1]).toMatchObject({ p_target: TARGET, p_context: "profile", p_request_id: null });
    await fireEvent.press(screen.getByText(safetyText.close));
    await fireEvent.press(screen.getByTestId("safety-block"));
    expect(await screen.findByText(safetyText.blockNote)).toBeTruthy();
    await fireEvent.press(screen.getByTestId("safety-submit"));
    expect(await screen.findByText(safetyText.blocked)).toBeTruthy();
    await fireEvent.press(screen.getByText(safetyText.close));
    expect(await screen.findByText(likesText.emptyReceived)).toBeTruthy();
    expect(calls(db, "block_user")[0][1]).toEqual({ p_target: TARGET });
  });

  it("answers the web's text when a list cannot be read, and sends an incomplete profile to onboarding", async () => {
    await open(likes({ sent: [{ broken: true }] }).services, "/likes");
    expect(await screen.findByText(LOAD_UNAVAILABLE)).toBeTruthy();
    expect(screen.getByText(likesText.title)).toBeTruthy();
    const router = await open(fakeServices(() => ok([accountRow({ profile_completed: false })])).services, "/likes");
    await waitFor(() => expect(router.getPathname()).toBe("/onboarding"));
  });

  it("never calls a request RPC", async () => {
    const { services, db } = likes();
    await open(services, "/likes");
    await fireEvent.press(await screen.findByTestId(`like-back-${TARGET}`));
    await screen.findByText(likeText.liked);
    expect(db.rpc.mock.calls.map(([name]) => name).filter((name) => /request|set_modes/.test(name) && name !== "request_account_deletion")).toEqual([]);
  });
});

describe("talk list (M3)", () => {
  it("lists conversations, re-reads on a new message and leaves the channel on close", async () => {
    let rows = [conversationRow()];
    const fake = fakeServices((name) => name === "my_account" ? eligible() : name === "list_messages" ? ok([]) : ok(rows));
    const router = await open(fake.services, "/talk");
    expect(await screen.findByText("こんにちは")).toBeTruthy();
    expect(screen.getByText(talkListText.unread)).toBeTruthy();
    await waitFor(() => expect(fake.channels).toHaveLength(1));
    expect(fake.channels[0]).toMatchObject({ name: "talk-list", filter: { event: "INSERT", schema: "public", table: "messages" } });
    rows = [conversationRow({ last_message_body: "新しい発言", unread: false })];
    await act(async () => { fake.channels[0].insert(); });
    expect(await screen.findByText("新しい発言")).toBeTruthy();
    expect(screen.queryByText(talkListText.unread)).toBeNull();
    await fireEvent.press(screen.getByTestId(`talk-row-${CONV}`));
    await waitFor(() => expect(router.getPathname()).toBe(`/talk/${CONV}`));
    await fireEvent.press(await screen.findByText(chatText.back));
    await waitFor(() => expect(router.getPathname()).toBe("/talk"));
    await waitFor(() => expect(fake.removeChannel).toHaveBeenCalled());
  });

  it("shows the empty state with the way to the likes", async () => {
    const fake = fakeServices((name) => name === "my_account" ? eligible() : ok([]));
    const router = await open(fake.services, "/talk");
    expect(await screen.findByText(talkListText.empty)).toBeTruthy();
    await fireEvent.press(screen.getByText(talkListText.toLikes));
    await waitFor(() => expect(router.getPathname()).toBe("/likes"));
    expect(fake.removeChannel).toHaveBeenCalled();
  });
});

describe("chat (M3)", () => {
  function room(options: { messages?: () => unknown[]; conversations?: () => unknown[]; send?: () => RpcAnswer } = {}) {
    return fakeServices((name) => {
      if (name === "my_account") return eligible();
      if (name === "list_my_conversations") return ok(options.conversations?.() ?? [conversationRow()]);
      if (name === "list_messages") return ok(options.messages?.() ?? [messageRow(1, USER), messageRow(2, TARGET), messageRow(3, TARGET, { hidden: true, body: "置換え済み" })]);
      if (name === "send_message") return options.send?.() ?? done();
      return done();
    });
  }

  it("shows the history, the hidden placeholder and marks the counterpart's last message read", async () => {
    const fake = room({ messages: () => [messageRow(1, USER), messageRow(2, TARGET), messageRow(3, USER, { hidden: true, body: "置換え済み" })] });
    await open(fake.services, `/talk/${CONV}`);
    expect(await screen.findByText("本文1")).toBeTruthy();
    expect(screen.getByText("本文2")).toBeTruthy();
    expect(screen.getByText(HIDDEN_CONTENT_TEXT)).toBeTruthy();
    expect(screen.queryByText("置換え済み")).toBeNull();
    expect(screen.getAllByText("12:00")).toHaveLength(3);
    // Only the counterpart's visible message can be reported.
    expect(screen.getByTestId("safety-report-message-2")).toBeTruthy();
    expect(screen.queryByTestId("safety-report-message-1")).toBeNull();
    expect(screen.queryByTestId("safety-report-message-3")).toBeNull();
    await waitFor(() => expect(fake.channels).toHaveLength(1));
    expect(fake.channels[0]).toMatchObject({ name: `chat:${CONV}`, filter: { filter: `conversation_id=eq.${CONV}` } });
    expect(calls(fake.db, "mark_read")).toHaveLength(0);
  });

  it("marks read when the newest message is the counterpart's", async () => {
    const fake = room({ messages: () => [messageRow(1, USER), messageRow(2, TARGET)] });
    await open(fake.services, `/talk/${CONV}`);
    await waitFor(() => expect(calls(fake.db, "mark_read")[0][1]).toEqual({ p_conversation: CONV, p_message_id: 2 }));
  });

  it("shows a counterpart's hidden message as the placeholder, without a report button", async () => {
    await open(room().services, `/talk/${CONV}`);
    expect(await screen.findByTestId("message-hidden-3")).toBeTruthy();
    expect(screen.getByText(HIDDEN_CONTENT_TEXT)).toBeTruthy();
    expect(screen.queryByTestId("safety-report-message-3")).toBeNull();
  });

  it("sends with a UUID client id and shows the new message", async () => {
    let rows = [messageRow(1, USER)];
    const fake = room({ messages: () => rows, send: () => { rows = [...rows, messageRow(2, USER, { body: "送った本文" })]; return done(); } });
    await open(fake.services, `/talk/${CONV}`);
    await screen.findByText("本文1");
    expect(screen.getByTestId("chat-send").props.accessibilityState.disabled).toBe(true);
    await fireEvent.changeText(screen.getByTestId("chat-body"), "送った本文");
    expect(screen.getByText("5 / 2000文字")).toBeTruthy();
    await fireEvent.press(screen.getByTestId("chat-send"));
    expect(await screen.findByText(chatText.sent)).toBeTruthy();
    expect(screen.getAllByText("送った本文").length).toBeGreaterThan(0);
    const [, args] = calls(fake.db, "send_message")[0] as [string, Record<string, unknown>];
    expect(args).toMatchObject({ p_conversation: CONV, p_body: "送った本文" });
    expect(args.p_client_msg_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(screen.getByTestId("chat-body").props.value).toBe("");
  });

  it("keeps the client id for a retry after a network failure", async () => {
    let attempt = 0;
    const fake = room({ send: () => attempt++ === 0 ? { data: null, error: { code: "500" }, status: 500 } : done() });
    await open(fake.services, `/talk/${CONV}`);
    await fireEvent.changeText(await screen.findByTestId("chat-body"), "もう一度");
    await fireEvent.press(screen.getByTestId("chat-send"));
    expect(await screen.findByText(chatText.sendFailed)).toBeTruthy();
    await fireEvent.press(screen.getByTestId("chat-send"));
    expect(await screen.findByText(chatText.sent)).toBeTruthy();
    const ids = calls(fake.db, "send_message").map(([, args]) => (args as Record<string, unknown>).p_client_msg_id);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
  });

  it("shows the web's rate limit message", async () => {
    await open(room({ send: () => refusal("rate_limited") }).services, `/talk/${CONV}`);
    await fireEvent.changeText(await screen.findByTestId("chat-body"), "連投");
    await fireEvent.press(screen.getByTestId("chat-send"));
    expect(await screen.findByText(chatText.rateLimited)).toBeTruthy();
  });

  it("adds a message that arrives through Realtime", async () => {
    let rows = [messageRow(1, USER)];
    const fake = room({ messages: () => rows });
    await open(fake.services, `/talk/${CONV}`);
    await screen.findByText("本文1");
    await waitFor(() => expect(fake.channels).toHaveLength(1));
    rows = [messageRow(1, USER), messageRow(2, TARGET, { body: "届いた発言" })];
    await act(async () => { fake.channels[0].insert(); });
    expect(await screen.findByText("届いた発言")).toBeTruthy();
    await waitFor(() => expect(calls(fake.db, "mark_read").at(-1)?.[1]).toEqual({ p_conversation: CONV, p_message_id: 2 }));
  });

  it("closes the room once the conversation is gone (a block from the other side)", async () => {
    let gone = false;
    const fake = room({ conversations: () => gone ? [] : [conversationRow()] });
    await open(fake.services, `/talk/${CONV}`);
    await screen.findByText("本文1");
    await waitFor(() => expect(fake.channels).toHaveLength(1));
    gone = true;
    await act(async () => { fake.channels[0].insert(); });
    expect(await screen.findByText(chatText.missing)).toBeTruthy();
    expect(screen.queryByText("本文1")).toBeNull();
    await waitFor(() => expect(fake.removeChannel).toHaveBeenCalled());
  });

  it("blocks from the room's menu and closes the room", async () => {
    const fake = room();
    await open(fake.services, `/talk/${CONV}`);
    await fireEvent.press(await screen.findByTestId("safety-menu"));
    await fireEvent.press(await screen.findByTestId("safety-menu-block"));
    await fireEvent.press(await screen.findByTestId("safety-submit"));
    expect(await screen.findByText(safetyText.blocked)).toBeTruthy();
    expect(calls(fake.db, "block_user")[0][1]).toEqual({ p_target: TARGET });
    expect(fake.clearImages).toHaveBeenCalled();
    await fireEvent.press(screen.getByText(safetyText.close));
    expect(await screen.findByText(chatText.missing)).toBeTruthy();
  });

  it("reports a counterpart's message", async () => {
    const fake = room();
    await open(fake.services, `/talk/${CONV}`);
    await fireEvent.press(await screen.findByTestId("safety-report-message-2"));
    expect(await screen.findAllByText("本文2")).toHaveLength(2);
    await fireEvent.press(screen.getByTestId("safety-submit"));
    expect(await screen.findByText(safetyText.reported)).toBeTruthy();
    expect(calls(fake.db, "submit_report")[0][1]).toMatchObject({ p_target: TARGET, p_context: "message", p_message_id: 2 });
  });

  it.each([["a conversation that is not the user's", CONV, []], ["a malformed id", "nope", [conversationRow()]]] as const)("gives %s the one missing screen", async (_label, id, rows) => {
    await open(room({ conversations: () => [...rows] }).services, `/talk/${id}`);
    expect(await screen.findByText(chatText.missing)).toBeTruthy();
  });
});
