import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import type { ReactNode } from "react";
import { View } from "react-native";
import { initialWindowMetrics, SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
import { AuthProvider, type AuthServices } from "./auth-context";
import { colors } from "./theme";

// FIX-005: every screen, its tab bar and the chat composer sit inside the safe area: below the status bar and the
// Dynamic Island, and above the home indicator. Each screen keeps its own spacing inside the frame.
export function SafeFrame({ children }: { children: ReactNode }) {
  const insets = useSafeAreaInsets();
  return <View testID="safe-frame" style={{
    flex: 1, backgroundColor: colors.white,
    paddingTop: insets.top, paddingBottom: insets.bottom, paddingLeft: insets.left, paddingRight: insets.right,
  }}>{children}</View>;
}

/** The root of the app (app/_layout.tsx): the safe area, the session and the screen stack. */
export function AppShell({ services }: { services: AuthServices | null }) {
  return <SafeAreaProvider initialMetrics={initialWindowMetrics}>
    <AuthProvider services={services}>
      <StatusBar style="dark" />
      <SafeFrame>
        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.white } }} />
      </SafeFrame>
    </AuthProvider>
  </SafeAreaProvider>;
}
