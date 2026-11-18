import { Link, Redirect } from "expo-router";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { listMyPhotos, loadMyPage, type Failure, type MyPageData } from "../src/account-data";
import { useAuth } from "../src/auth-context";
import { LOAD_UNAVAILABLE, myPageText as text, photoMessages, settingsLinks } from "../src/messages";
import { PhotoManager } from "../src/photo-manager";
import { MainNav } from "../src/screen";
import { SignOutControls } from "../src/sign-out";
import { ui } from "../src/theme";
import { openWebPage, SessionExpired } from "../src/ui";

type Loaded = { status: "ok"; page: MyPageData; photos: string[] | null } | { status: "incomplete" } | Failure;

// MOBILE-002: the web's src/components/mypage-live.tsx on the device, with photo management (docs/42 §7.1 M1).
// MOBILE-004: the privacy, block and account settings, and both sign-outs (M4).
// MOBILE-LIKES-001: the profile edit screen comes first, as on the web (docs/43 §4.5).
export default function MyPageScreen() {
  const { ready, signedIn, services } = useAuth();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (!services || !signedIn) return;
    let active = true;
    void (async () => {
      const result = await loadMyPage(services.supabase);
      const next: Loaded = result.status === "ok" ? { ...result, photos: await listMyPhotos(services.supabase) } : result;
      if (active) setLoaded(next);
    })();
    return () => { active = false; };
  }, [services, signedIn]);

  if (!ready || leaving) return <View style={ui.page} />;
  if (!signedIn) return <Redirect href="/" />;
  if (loaded?.status === "incomplete") return <Redirect href="/onboarding" />;
  if (!loaded && services) return <View style={ui.page} />;

  const logout = <SignOutControls onLeaving={() => setLeaving(true)} />;

  if (!loaded || loaded.status !== "ok") {
    return <ScrollView contentContainerStyle={ui.page}>
      <Text style={ui.brand}>Campus Link</Text>
      {loaded?.status === "unauthenticated" ? <SessionExpired /> :
        <Text testID="mypage-unavailable" style={ui.message} accessibilityRole="alert">{LOAD_UNAVAILABLE}</Text>}
      {logout}
    </ScrollView>;
  }

  const { page, photos } = loaded;
  return <View style={{ flex: 1 }}><ScrollView contentContainerStyle={ui.page}>
    <Text style={ui.title} accessibilityRole="header">マイページ</Text>
    <Text testID="mypage-name" style={[ui.note, { fontSize: 15 }]}>{page.name}</Text>
    {page.accountStatus === "suspended" ? <Text style={[ui.body, { marginTop: 16 }]}>{text.suspended}</Text> : null}
    {page.accountStatus === "deactivated" ? <View style={[ui.rowTight, { marginTop: 16, alignItems: "center" }]}>
      <Text style={ui.body}>{text.deactivated}</Text>
      <Link href="/settings/account" style={ui.textLink}><Text style={ui.textLinkText}>{settingsLinks.resume}</Text></Link>
    </View> : null}

    <View style={ui.section} accessibilityLabel="確認状況">
      <Text style={ui.sectionTitle} accessibilityRole="header">確認状況</Text>
      <View style={[ui.rowTight, { justifyContent: "space-between" }]}><Text style={ui.value}>年齢確認</Text>
        <Text testID="mypage-age" style={ui.value}>{page.ageVerified ? "確認済み" : "未確認"}</Text></View>
      <View style={[ui.rowTight, { justifyContent: "space-between" }]}><Text style={ui.value}>在学確認</Text>
        <Text testID="mypage-affiliation" style={ui.value}>{text.affiliation[page.affiliation]}</Text></View>
      {!page.eligible && page.accountStatus !== "deactivated" ? <View>
        <Text style={ui.body}>{text.needsVerification}</Text>
        <Link href="/verification" style={ui.textLink}><Text style={ui.textLinkText}>在学・年齢確認へ</Text></Link>
      </View> : null}
    </View>

    <View style={ui.outlined} accessibilityLabel="写真">
      <Text style={ui.sectionTitle} accessibilityRole="header">写真</Text>
      {photos === null ? <Text testID="mypage-photos-unavailable" style={ui.message} accessibilityRole="alert">{photoMessages.unavailable}</Text> :
        <PhotoManager initial={photos} />}
    </View>

    <View style={[ui.section, { padding: 8, gap: 8 }]} accessibilityLabel="設定">
      <Text style={[ui.sectionTitle, { paddingHorizontal: 12, paddingTop: 8 }]} accessibilityRole="header">設定</Text>
      {([["/settings/profile", settingsLinks.profile, "profile"], ["/settings/privacy", settingsLinks.privacy, "privacy"], ["/settings/blocks", settingsLinks.blocks, "blocks"],
        ["/settings/account", settingsLinks.account, "account"], ["/verification", "在学・年齢確認", "verification"]] as const).map(([href, label, id]) =>
        <Link key={href} href={href} asChild><Pressable testID={`mypage-link-${id}`} accessibilityRole="link" style={ui.listItem}><Text style={ui.value}>{label}</Text></Pressable></Link>)}
      {services ? <>
        <Pressable testID="mypage-terms" accessibilityRole="link" style={ui.listItem} onPress={() => openWebPage(services.termsUrl)}><Text style={ui.value}>利用規約</Text></Pressable>
        <Pressable testID="mypage-privacy" accessibilityRole="link" style={ui.listItem} onPress={() => openWebPage(services.privacyUrl)}><Text style={ui.value}>プライバシーポリシー</Text></Pressable>
      </> : null}
    </View>
    {logout}
  </ScrollView><MainNav current="mypage" /></View>;
}
