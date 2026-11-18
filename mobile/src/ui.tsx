import { useRouter } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import type { ReactNode } from "react";
import { Pressable, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { useAuth } from "./auth-context";
import { SESSION_EXPIRED } from "./messages";
import { ui } from "./theme";

// MOBILE-002: small controls shared by the signed-in screens, in MOBILE-001's style.
export function Button({ label, onPress, disabled = false, busy = false, kind = "primary", testID, style, accessibilityLabel }: {
  label: string; onPress: () => void; disabled?: boolean; busy?: boolean; kind?: "primary" | "secondary" | "small";
  testID?: string; style?: StyleProp<ViewStyle>; accessibilityLabel?: string;
}) {
  const base = kind === "primary" ? ui.primaryButton : kind === "secondary" ? ui.secondaryButton : ui.smallButton;
  return <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={accessibilityLabel} accessibilityState={{ disabled, busy }} disabled={disabled}
    onPress={onPress} style={[base, disabled && ui.disabled, style]}>
    <Text style={kind === "primary" ? ui.primaryButtonText : ui.secondaryButtonText}>{label}</Text>
  </Pressable>;
}

/** A selectable option (radio or checkbox role), the app's counterpart of the web's radios, checkboxes and selects. */
export function Choice({ label, selected, onPress, role = "radio", disabled = false, testID }: {
  label: string; selected: boolean; onPress: () => void; role?: "radio" | "checkbox"; disabled?: boolean; testID?: string;
}) {
  return <Pressable testID={testID} accessibilityRole={role} accessibilityLabel={label}
    accessibilityState={role === "radio" ? { selected, disabled } : { checked: selected, disabled }} disabled={disabled}
    onPress={onPress} style={[ui.choice, selected && ui.choiceSelected, disabled && ui.disabled]}>
    <Text style={ui.choiceText}>{label}</Text>
  </Pressable>;
}

export function Alert({ children, testID }: { children: ReactNode; testID?: string }) {
  return <View testID={testID} accessibilityRole="alert" accessibilityLiveRegion="polite" style={{ marginTop: 16, gap: 4 }}>{children}</View>;
}

export function FieldError({ message }: { message?: string }) {
  return message ? <Text style={ui.error}>{message}</Text> : null;
}

/** "ログインの有効期限が切れました。" with the way back: this device's session ends and the sign-in screen opens. */
export function SessionExpired() {
  const { signOut } = useAuth();
  const router = useRouter();
  return <Alert testID="session-expired">
    <Text style={ui.message}>{SESSION_EXPIRED}</Text>
    <Pressable accessibilityRole="link" style={ui.textLink} onPress={() => void signOut().then(() => router.replace("/sign-in"))}>
      <Text style={ui.textLinkText}>ログインへ</Text>
    </Pressable>
  </Alert>;
}

/**
 * MOBILE-004 (docs/42 §2.2): the terms and the privacy policy are the web's own pages, opened in the in-app browser
 * (SFSafariViewController), never in a WebView. A page that cannot open stays closed; nothing is logged.
 */
export function openWebPage(url: string): void {
  void WebBrowser.openBrowserAsync(url).catch(() => {});
}
