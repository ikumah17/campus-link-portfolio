/// <reference types="node" />
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  chatText, discoverText, HIDDEN_CONTENT_TEXT, likeMessages, likesText, likeText, LIKES_MORE, myPageText, navText, onboardingText, photoMessages,
  PROFILE_UNAVAILABLE, profileEditText, profileText, safetyMessages, safetyText, searchText, SERVICE_UNAVAILABLE, talkListText, verificationText,
  WELCOME_LINE,
  accountMessages, accountText, blocksText, DELETE_CONFIRMATION, hideTargetKindLabel, logoutText, PAUSE_NOTE, privacyText, settingsLinks,
  unblockText,
} from "../src/messages";
import * as allMessages from "../src/messages";

// MOBILE-002: the app's copies of the web's on-screen text must still match the web components word for word.
function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (value && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}

describe("text copied from the web", () => {
  it.each([
    ["src/components/onboarding.tsx", onboardingText],
    ["src/components/photo-manager.tsx", photoMessages],
    ["src/components/verification-live.tsx", verificationText],
    ["src/components/mypage-live.tsx", myPageText],
    ["src/app/page.tsx", SERVICE_UNAVAILABLE],
    ["src/components/discover-live.tsx", discoverText],
    ["src/components/search-conditions.tsx", searchText],
    ["src/components/profile-detail-live.tsx", profileText],
    ["src/components/profile-detail.tsx", PROFILE_UNAVAILABLE],
    ["src/components/like-controls.tsx", likeText],
    ["src/components/like-controls.tsx", likeMessages],
    ["src/components/likes-view.tsx", likesText],
    ["src/components/likes-live.tsx", LIKES_MORE],
    ["src/components/profile-edit.tsx", profileEditText],
    ["src/app/welcome/page.tsx", WELCOME_LINE],
    ["src/components/talk-list-live.tsx", talkListText],
    ["src/components/chat-room-live.tsx", chatText],
    ["src/components/hidden-content.tsx", HIDDEN_CONTENT_TEXT],
    ["src/components/safety-controls-live.tsx", safetyMessages],
    ["src/components/safety-controls-live.tsx", safetyText],
    ["src/components/main-nav.tsx", navText],
    ["src/server/account-rules.ts", { DELETE_CONFIRMATION, PAUSE_NOTE, accountMessages }],
    ["src/components/account-settings.tsx", accountText],
    ["src/components/logout-button.tsx", logoutText],
    ["src/components/mypage-live.tsx", settingsLinks],
    ["src/components/privacy-settings-live.tsx", privacyText],
    ["src/data/demo-privacy.ts", hideTargetKindLabel],
    ["src/components/blocks-settings-live.tsx", blocksText],
    ["src/components/safety-controls-live.tsx", unblockText],
  ])("%s still contains every string", (file, text) => {
    const source = readFileSync(resolve(__dirname, "../..", file), "utf8");
    const list = strings(text);
    expect(list.length).toBeGreaterThan(0);
    for (const value of list) expect({ value, found: source.includes(value) }).toEqual({ value, found: true });
  });
});

// MOBILE-LIKES-001 (docs/43): no mode and no request text is left in the app's copies.
describe("no mode or request text", () => {
  it("is left in any copied string", () => {
    const all = strings(allMessages);
    for (const word of ["申請", "恋愛", "友達", "モード"]) expect(all.filter((value) => value.includes(word))).toEqual([]);
  });
});
