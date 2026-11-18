import { Redirect } from "expo-router";
import { useEffect, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { accountGate, type Gate } from "../src/account-data";
import { useAuth } from "../src/auth-context";
import { LOAD_UNAVAILABLE } from "../src/messages";
import { ui } from "../src/theme";
import { Button, SessionExpired } from "../src/ui";

// MOBILE-002: the web's profileGate (docs/42 §2) at the app's start. my_account decides where a signed-in user goes:
// onboarding until the profile is complete, then discovery (the web's /, MOBILE-003). A deleted account sees no
// screen, only the way out.
export default function HomeScreen() {
  const { ready, signedIn, services, signOut } = useAuth();
  const [gate, setGate] = useState<Gate | null>(null);

  useEffect(() => {
    if (!services || !signedIn) return;
    let active = true;
    void accountGate(services.supabase).then((value) => { if (active) setGate(value); });
    return () => { active = false; };
  }, [services, signedIn]);

  if (!ready) return <View style={ui.page} />;
  if (!signedIn) return <Redirect href="/" />;
  if (gate?.status === "onboarding") return <Redirect href="/onboarding" />;
  if (gate?.status === "complete") return <Redirect href="/discover" />;
  if (!gate && services) return <View style={ui.page} />;

  return <ScrollView contentContainerStyle={ui.page}>
    <Text style={ui.brand}>Campus Link</Text>
    {gate?.status === "unauthenticated" ? <SessionExpired /> : <>
      <Text testID="home-unavailable" style={ui.message} accessibilityRole="alert">{LOAD_UNAVAILABLE}</Text>
      <View style={ui.actions}>
        <Button testID="sign-out" kind="secondary" label="ログアウト" onPress={() => void signOut()} />
      </View>
    </>}
  </ScrollView>;
}
