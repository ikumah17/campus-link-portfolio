import { useRouter } from "expo-router";
import { useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useAuth } from "./auth-context";
import { logoutText as text } from "./messages";
import { colors, ui } from "./theme";
import { Button } from "./ui";

/**
 * MOBILE-004: the web's LogoutButton and LogoutEverywhereButton (src/components/logout-button.tsx, docs/42 §3.4).
 * "ログアウト" ends this device's session and opens the welcome screen. "すべての端末からログアウト" revokes every
 * session; when Auth does not confirm it, the sign-in screen opens with the web's fixed signout text (FIX-002 N-4),
 * never the welcome screen of a success. The Keychain session is cleared either way (src/auth-context.tsx).
 * onLeaving runs first, so the screen shows nothing while the session ends instead of redirecting on its own.
 */
export function SignOutControls({ onLeaving, local = true }: { onLeaving: () => void; local?: boolean }) {
  const { signOut, signOutEverywhere } = useAuth();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  async function leave(everywhere: boolean) {
    if (running.current) return;
    running.current = true; setBusy(true); onLeaving();
    if (everywhere) {
      const result = await signOutEverywhere().catch(() => "failed" as const);
      router.replace(result === "ok" ? "/" : { pathname: "/sign-in", params: { error: "signout" } });
    } else {
      await signOut().catch(() => {});
      router.replace("/");
    }
  }
  return <View style={ui.actions}>
    {local ? <Button testID="sign-out" kind="secondary" label={text.local} disabled={busy} busy={busy} onPress={() => void leave(false)} /> : null}
    <Pressable testID="sign-out-everywhere" accessibilityRole="button" accessibilityState={{ disabled: busy, busy }} disabled={busy}
      onPress={() => void leave(true)} style={[ui.textLink, { alignSelf: "center" }, busy && ui.disabled]}>
      <Text style={[ui.textLinkText, { color: colors.muted }]}>{text.everywhere}</Text>
    </Pressable>
  </View>;
}
