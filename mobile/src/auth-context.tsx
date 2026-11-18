import type { SupabaseClient } from "@supabase/supabase-js";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { AppState } from "react-native";
import { Image } from "expo-image";
import { createAuthApi, type AuthApi } from "./api";
import { readConfig } from "./config";
import { createPhotoApi, type PhotoApi } from "./photos";
import type { AuthFieldErrors, AuthStatus } from "./shared";
import { secureSessionStorage } from "./secure-storage";
import { createSupabase, SESSION_STORAGE_KEY } from "./supabase";

// MOBILE-001: sign-in and sign-up go through MOBILE-API-001 (docs/42 §3.3 A), so the web's rate limits, failure
// floor and deleted-account handling apply. The returned session is handed to supabase-js, which keeps it in the
// Keychain (src/secure-storage.ts) and refreshes it only while the app is in the foreground.
export type AuthResult = { status: Exclude<AuthStatus, "idle"> | "ok"; fieldErrors?: AuthFieldErrors };
// MOBILE-002: the photo API, the API base URL for photo delivery, and the image memory cache to clear at sign-out.
// MOBILE-004: clearSession removes the Keychain session directly, the last step of every sign-out.
export type AuthServices = {
  api: AuthApi; supabase: SupabaseClient; termsUrl: string; privacyUrl: string;
  apiBaseUrl: string; photos: PhotoApi; clearImages: () => Promise<unknown>; clearSession: () => Promise<unknown>;
};
/** "failed": Auth did not confirm that the other devices' sessions ended (FIX-002 N-4); this device's ended anyway. */
export type SignOutEverywhereResult = "ok" | "failed";

type AuthContextValue = {
  ready: boolean;
  signedIn: boolean;
  services: AuthServices | null;
  signIn: (email: string, password: string) => Promise<AuthResult>;
  signUp: (email: string, password: string) => Promise<AuthResult>;
  signOut: () => Promise<void>;
  signOutEverywhere: () => Promise<SignOutEverywhereResult>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

/** The real services, or null when the configuration is missing (every screen then answers "unavailable"). */
export function defaultServices(): AuthServices | null {
  const config = readConfig();
  if (!config) return null;
  const supabase = createSupabase(config);
  return {
    api: createAuthApi(config.apiBaseUrl),
    supabase,
    termsUrl: `${config.apiBaseUrl}/terms`,
    privacyUrl: `${config.apiBaseUrl}/privacy`,
    apiBaseUrl: config.apiBaseUrl,
    // getSession refreshes an expired access token before it is used.
    photos: createPhotoApi(config.apiBaseUrl, async () => (await supabase.auth.getSession()).data.session?.access_token ?? null),
    clearImages: () => Image.clearMemoryCache(),
    clearSession: () => secureSessionStorage.removeItem(SESSION_STORAGE_KEY),
  };
}

// Whatever happened at Auth, nothing of the session stays on the device: the Keychain value is removed directly, and
// delivered photos, kept only in the memory cache (docs/42 §2.2), are dropped.
async function clearDevice(services: AuthServices): Promise<void> {
  await Promise.resolve().then(services.clearSession).catch(() => {});
  await Promise.resolve().then(services.clearImages).catch(() => {});
}

export function AuthProvider({ services, children }: { services: AuthServices | null; children: ReactNode }) {
  const [ready, setReady] = useState(services === null);
  const [signedIn, setSignedIn] = useState(false);

  useEffect(() => {
    if (!services) return;
    const { supabase } = services;
    let active = true;
    supabase.auth.getSession()
      .then(({ data }) => { if (active) setSignedIn(!!data.session); })
      .catch(() => { if (active) setSignedIn(false); })
      .finally(() => { if (active) setReady(true); });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      if (active) setSignedIn(!!session);
    });
    const refresh = (state: string) => {
      if (state === "active") void supabase.auth.startAutoRefresh();
      else void supabase.auth.stopAutoRefresh();
    };
    refresh(AppState.currentState ?? "active");
    const subscription = AppState.addEventListener("change", refresh);
    return () => {
      active = false;
      listener.subscription.unsubscribe();
      subscription.remove();
      void supabase.auth.stopAutoRefresh();
    };
  }, [services]);

  const value = useMemo<AuthContextValue>(() => ({
    ready,
    signedIn,
    services,
    async signIn(email, password) {
      if (!services) return { status: "unavailable" };
      const answer = await services.api.signIn(email, password);
      if (answer.status !== "ok") return answer;
      try {
        const { error } = await services.supabase.auth.setSession(answer.session);
        if (!error) return { status: "ok" };
      } catch {
        // Fall through: a session that could not be checked is not kept.
      }
      await services.supabase.auth.signOut({ scope: "local" }).catch(() => {});
      return { status: "unavailable" };
    },
    async signUp(email, password) {
      if (!services) return { status: "unavailable" };
      return services.api.signUp(email, password);
    },
    async signOut() {
      if (!services) return;
      // Local scope ends this device's session; supabase-js removes it from the Keychain even if Auth is unreachable.
      await services.supabase.auth.signOut({ scope: "local" }).catch(() => {});
      await clearDevice(services);
      setSignedIn(false);
    },
    // docs/42 §3.4 and the web's signOutEverywhereAction (SEC-005 L-5): global scope revokes every refresh token. The
    // error is never shown or logged; a failure is reported as "failed" so the screen does not show it as a success.
    async signOutEverywhere() {
      if (!services) return "failed";
      let failed = false;
      try {
        const { error } = await services.supabase.auth.signOut({ scope: "global" });
        failed = !!error;
      } catch {
        failed = true;
      }
      // auth-js removes this device's session even when the revoke fails; if it threw first, end it locally as well.
      if (failed) await services.supabase.auth.signOut({ scope: "local" }).catch(() => {});
      await clearDevice(services);
      setSignedIn(false);
      return failed ? "failed" : "ok";
    },
  }), [ready, signedIn, services]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth outside AuthProvider");
  return value;
}
