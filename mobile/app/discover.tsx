import { Link, useLocalSearchParams, useRouter } from "expo-router";
import { useRef, useState } from "react";
import { Pressable, ScrollView, Text, View, type ScrollViewInstance } from "react-native";
import { useAuth } from "../src/auth-context";
import { LikeControls } from "../src/dialogs";
import { conditionLabels, conditionParams, genders, loadDiscover, type DiscoverParams } from "../src/discover-data";
import { discoverText as text, SERVICE_UNAVAILABLE } from "../src/messages";
import { gateView, MainNav, RemotePhoto, useLoad, usePhotoToken } from "../src/screen";
import { purposeText } from "../src/shared";
import { ui } from "../src/theme";
import { Button } from "../src/ui";

// MOBILE-003: the web's / (src/app/page.tsx, src/components/discover-live.tsx). The conditions are route params, as
// the web keeps them in the URL; a page is replaced by the next one, and no count is shown. MOBILE-LIKES-001: one list
// (no mode tabs; an old mode param is ignored), the purposes on the cards and a like button on each (docs/43 §4.2, Q8).
export default function DiscoverScreen() {
  const { ready, signedIn, services } = useAuth();
  const router = useRouter();
  const params = useLocalSearchParams<DiscoverParams>();
  const [after, setAfter] = useState<string | undefined>(undefined);
  const scroll = useRef<ScrollViewInstance>(null);
  const key = JSON.stringify([params.min, params.max, params.g, params.s, after]);
  const { value } = useLoad((s) => loadDiscover(s.supabase, params, after), key);
  const loaded = value?.status === "ok" ? value : null;
  const token = usePhotoToken(loaded ? loaded.profiles.map((p) => p.photoIds[0] ?? "").join(",") : "");

  const blocked = gateView(ready, signedIn, !!services, value, SERVICE_UNAVAILABLE);
  if (blocked) return blocked;
  if (value?.status === "not_eligible") {
    return <View style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={ui.page}>
        <Text style={ui.brand}>Campus Link</Text>
        <Text testID="discover-not-eligible" style={[ui.body, { lineHeight: 28 }]}>{text.notEligible}</Text>
        <View style={ui.actions}><Button label={text.toVerification} onPress={() => router.push("/verification")} /></View>
      </ScrollView>
      <MainNav current="discover" />
    </View>;
  }
  if (!loaded) return null;

  const { profiles, nextAfter, schools, conditions } = loaded;
  const labels = conditionLabels(conditions, schools);
  function page(next: string | undefined) { setAfter(next); scroll.current?.scrollTo({ y: 0, animated: false }); }

  return <View style={{ flex: 1 }}>
    <ScrollView ref={scroll} contentContainerStyle={ui.page}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: 16 }}>
        <Text style={[ui.brand, { marginBottom: 0 }]} accessibilityRole="header">Campus Link</Text>
        <Link href={{ pathname: "/search", params: conditionParams(conditions) }} asChild>
          <Pressable testID="discover-conditions" accessibilityRole="link" style={ui.smallButton}><Text style={ui.secondaryButtonText}>{text.conditions}</Text></Pressable>
        </Link>
      </View>
      <View style={ui.row}>
        {labels.map((label) => <Text key={label} style={ui.chip}>{label}</Text>)}
        {labels.length ? <Button testID="discover-clear" kind="small" label={text.clear}
          onPress={() => { setAfter(undefined); router.setParams({ min: undefined, max: undefined, g: undefined, s: undefined }); }} /> : null}
      </View>

      {profiles.map((p) => <View key={p.id} testID="discover-card" style={ui.card}>
        <RemotePhoto id={p.photoIds[0]} token={token} label={`${p.name}の写真`} style={ui.cardPhoto} />
        <View style={ui.cardBody}>
          <Text style={ui.name}>{p.name} <Text style={ui.age}>{p.age}{text.age}</Text></Text>
          <Text style={ui.note}>{genders.find((g) => g.id === p.gender)?.label}</Text>
          <Text style={[ui.note, { marginTop: 0 }]}>{[p.school, p.department, p.class].filter((v) => v !== null).join(" / ")}</Text>
          {p.purposes.length ? <Text testID={`discover-purposes-${p.id}`} style={[ui.note, { marginTop: 0, fontSize: 13 }]}>{purposeText(p.purposes)}</Text> : null}
          {p.bio ? <Text style={ui.body}>{p.bio}</Text> : null}
          {p.hobbies.length ? <View style={ui.rowTight}>{p.hobbies.map((h) => <Text key={h} style={ui.chip}>{h}</Text>)}</View> : null}
          <Button testID={`discover-view-${p.id}`} label={text.view} style={{ marginTop: 8 }}
            onPress={() => router.push({ pathname: "/profiles/[id]", params: { id: p.id } })} />
          <LikeControls id={p.id} name={p.name} testID={`discover-like-${p.id}`} />
        </View>
      </View>)}
      {!profiles.length ? <View style={{ marginTop: 32, alignItems: "center", gap: 8 }}>
        <Text testID="discover-empty" style={ui.note}>{text.empty}</Text>
        {after ? <Button kind="small" label={text.fromStart} onPress={() => page(undefined)} /> : null}
      </View> : null}
      {nextAfter ? <Button testID="discover-next" kind="secondary" label={text.next} style={{ marginTop: 32 }} onPress={() => page(nextAfter)} /> : null}
    </ScrollView>
    <MainNav current="discover" />
  </View>;
}
