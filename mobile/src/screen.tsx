import { Redirect, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { Image } from "expo-image";
import { Pressable, ScrollView, Text, View, type StyleProp, type ImageStyle } from "react-native";
import { useAuth, type AuthServices } from "./auth-context";
import { navText } from "./messages";
import { photoSource } from "./photos";
import { colors, ui } from "./theme";
import { SessionExpired } from "./ui";

// MOBILE-003: the parts every signed-in screen of M2–M3 shares.

/**
 * Loads a screen's data once services and the session are ready, and again on reload(). A reload keeps the shown
 * value until the new one arrives; a load that finishes after the screen closed or a newer load started is dropped.
 */
export function useLoad<T>(load: (services: AuthServices) => Promise<T>, key: string) {
  const { services, signedIn } = useAuth();
  const [value, setValue] = useState<T | null>(null);
  const generation = useRef(0);
  const loader = useRef(load);
  loader.current = load;
  const reload = useCallback(async () => {
    if (!services || !signedIn) return;
    const mine = ++generation.current;
    const next = await loader.current(services).catch(() => null);
    if (mine === generation.current && next !== null) setValue(next);
  }, [services, signedIn]);
  useEffect(() => {
    setValue(null);
    void reload();
    return () => { generation.current++; };
  }, [reload, key]);
  return { value, reload };
}

/**
 * The answer of a screen that is not ready to show its content: blank while loading, the welcome screen when signed
 * out, onboarding while the profile is incomplete, the way back to sign-in for a refused token, and the web's fixed
 * text otherwise. Returns null when the screen can render.
 */
export function gateView(ready: boolean, signedIn: boolean, hasServices: boolean, value: { status: string } | null, unavailableText: string, title?: string): ReactElement | null {
  if (!ready) return <View style={ui.page} />;
  if (!signedIn) return <Redirect href="/" />;
  if (value?.status === "incomplete") return <Redirect href="/onboarding" />;
  if (!value && hasServices) return <View style={ui.page} />;
  if (value && value.status !== "unauthenticated" && value.status !== "unavailable") return null;
  return <ScrollView contentContainerStyle={ui.page}>
    {title ? <Text style={ui.title} accessibilityRole="header">{title}</Text> : <Text style={ui.brand}>Campus Link</Text>}
    {value?.status === "unauthenticated" ? <SessionExpired /> :
      <Text testID="screen-unavailable" style={[ui.message, title ? { marginTop: 32 } : null]} accessibilityRole="alert">{unavailableText}</Text>}
  </ScrollView>;
}

/** The delivery token for photos, re-read when the key (the shown photo ids) changes, so no request carries a stale token. */
export function usePhotoToken(key: string): string | null {
  const { services } = useAuth();
  const [token, setToken] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    if (services && key) void services.photos.token().then((value) => { if (active) setToken(value); });
    return () => { active = false; };
  }, [services, key]);
  return token;
}

/** One delivered photo (GET /api/mobile/photos/[id], Bearer only), kept in the memory cache only (MOBILE-002). */
export function RemotePhoto({ id, token, label, style, testID }: { id: string | null | undefined; token: string | null; label?: string; style: StyleProp<ImageStyle>; testID?: string }) {
  const { services } = useAuth();
  if (!id || !token || !services) return <View testID={testID ? `${testID}-empty` : undefined} style={[style as object, { backgroundColor: colors.surface }]} />;
  return <Image testID={testID} source={photoSource(services.apiBaseUrl, id, token)} cachePolicy="memory" contentFit="cover"
    style={style} accessibilityLabel={label} accessibilityIgnoresInvertColors />;
}

type NavPage = "discover" | "likes" | "talk" | "mypage";
const NAV: { page: NavPage; path: "/discover" | "/likes" | "/talk" | "/mypage" }[] = [
  { page: "discover", path: "/discover" }, { page: "likes", path: "/likes" }, { page: "talk", path: "/talk" }, { page: "mypage", path: "/mypage" },
];

/** The web's MainNav: the four tabs (MOBILE-LIKES-001: いいね replaces 申請; no mode is carried). */
export function MainNav({ current }: { current: NavPage }) {
  const router = useRouter();
  return <View accessibilityRole="tablist" style={ui.nav}>
    {NAV.map(({ page, path }) => <Pressable key={page} testID={`nav-${page}`} accessibilityRole="tab" accessibilityState={{ selected: current === page }}
      style={[ui.navItem, current === page && ui.navItemCurrent]}
      onPress={() => { if (current !== page) router.replace(path); }}>
      <Text style={[ui.navText, current === page && { color: colors.ink, fontWeight: "500" }]}>{navText[page]}</Text>
    </Pressable>)}
  </View>;
}
