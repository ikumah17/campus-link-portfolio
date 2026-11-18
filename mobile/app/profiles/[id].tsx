import { useLocalSearchParams, useRouter } from "expo-router";
import { ScrollView, Text, View } from "react-native";
import { useAuth } from "../../src/auth-context";
import { genders } from "../../src/discover-data";
import { LikeControls, NO_LIKE, SafetyControls } from "../../src/dialogs";
import { loadProfile } from "../../src/like-data";
import { discoverText, LOAD_UNAVAILABLE, PROFILE_UNAVAILABLE, profileText as text } from "../../src/messages";
import { gateView, MainNav, RemotePhoto, useLoad, usePhotoToken } from "../../src/screen";
import { purposeText } from "../../src/shared";
import { colors, ui } from "../../src/theme";
import { Button } from "../../src/ui";

// MOBILE-003: the web's /profiles/[id] (src/components/profile-detail-live.tsx) with the block and report buttons. A
// malformed id, a missing profile and one the viewer may not see give the same screen (P5). MOBILE-LIKES-001: no mode
// row; the rows are the bio, the hobbies and the purposes (empty ones are not shown), and the like buttons start from
// get_like_state (docs/43 §4.3).
export default function ProfileScreen() {
  const { ready, signedIn, services } = useAuth();
  const router = useRouter();
  const params = useLocalSearchParams<{ id: string }>();
  const { value } = useLoad((s) => loadProfile(s.supabase, params.id), params.id ?? "");
  const profile = value?.status === "ok" ? value.profile : null;
  const token = usePhotoToken(profile ? profile.photoIds.join(",") : "");
  const toList = () => router.replace("/discover");

  const blocked = gateView(ready, signedIn, !!services, value, LOAD_UNAVAILABLE);
  if (blocked) return blocked;
  if (!profile || value?.status !== "ok") {
    return <ScrollView contentContainerStyle={ui.page}>
      <Text testID="profile-unavailable" style={ui.title} accessibilityRole="header">{PROFILE_UNAVAILABLE}</Text>
      <Button kind="small" label={text.back} style={{ alignSelf: "flex-start", marginTop: 24 }} onPress={toList} />
    </ScrollView>;
  }

  const p = profile;
  const rows = ([["bio", p.bio], ["hobbies", p.hobbies.join(" / ")], ["purposes", purposeText(p.purposes)]] as const).filter(([, v]) => v);
  return <View style={{ flex: 1 }}>
    <ScrollView contentContainerStyle={ui.page}>
      <Button kind="small" label={text.back} style={{ alignSelf: "flex-start" }} onPress={toList} />
      {p.photoIds.map((id, i) => <RemotePhoto key={id} testID={`profile-photo-${i}`} id={id} token={token} label={`${p.name}の写真 ${i + 1}`} style={ui.detailPhoto} />)}
      <Text style={[ui.name, { marginTop: 24 }]} accessibilityRole="header">{p.name} <Text style={ui.age}>{p.age}{discoverText.age}</Text></Text>
      <Text style={ui.note}>{genders.find((g) => g.id === p.gender)?.label}</Text>
      <Text style={[ui.note, { marginTop: 4 }]}>{[p.school, p.department, p.class].filter((v) => v !== null).join(" / ")}</Text>
      {rows.length ? <View style={{ marginTop: 24, borderTopWidth: 1, borderColor: colors.line }}>
        {rows.map(([key, v]) => <View key={key} testID={`profile-row-${key}`} style={ui.detailRow}>
          <Text style={ui.detailLabel}>{text.rows[key]}</Text><Text style={ui.detailValue}>{v}</Text>
        </View>)}
      </View> : null}
      <View style={{ marginTop: 32, gap: 12 }}>
        <LikeControls id={p.id} name={p.name} initial={value.likeState ?? NO_LIKE} />
        <SafetyControls kind="profile" id={p.id} name={p.name} block onBlocked={toList} />
      </View>
    </ScrollView>
    <MainNav current="discover" />
  </View>;
}
