import { Link, Redirect } from "expo-router";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useAuth } from "../src/auth-context";
import { WELCOME_LINE } from "../src/messages";
import { ui } from "../src/theme";

// The web's /welcome (src/app/welcome/page.tsx), without the demo profiles.
// UI-015: 2:3 spacers put the block's centre at about 40% of the safe area;
// they collapse to nothing when the content is taller, so it still scrolls.
export default function WelcomeScreen() {
  const { ready, signedIn } = useAuth();
  if (!ready) return <View style={ui.page} />;
  if (signedIn) return <Redirect href="/home" />;
  return <ScrollView contentContainerStyle={ui.page} testID="welcome-scroll">
    <View testID="welcome-spacer-top" style={{ flexGrow: 2 }} />
    <View testID="welcome-content">
      <Text style={ui.brand}>Campus Link</Text>
      <Text style={ui.hero} accessibilityRole="header">学生生活に、{"\n"}新しいつながりを。</Text>
      <Text style={[ui.note, { fontSize: 15, marginTop: 16 }]}>{WELCOME_LINE}</Text>
      <View style={ui.actions}>
        <Link href="/sign-up" asChild>
          <Pressable accessibilityRole="button" style={ui.primaryButton}><Text style={ui.primaryButtonText}>新規登録</Text></Pressable>
        </Link>
        <Link href="/sign-in" asChild>
          <Pressable accessibilityRole="button" style={ui.secondaryButton}><Text style={ui.secondaryButtonText}>ログイン</Text></Pressable>
        </Link>
      </View>
    </View>
    <View testID="welcome-spacer-bottom" style={{ flexGrow: 3 }} />
  </ScrollView>;
}
  