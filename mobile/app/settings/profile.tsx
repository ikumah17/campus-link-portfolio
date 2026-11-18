import { useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useAuth } from "../../src/auth-context";
import { LOAD_UNAVAILABLE, profileEditText as text } from "../../src/messages";
import { loadProfileEdit, saveMyProfile, type ProfileEditStatus } from "../../src/profile-edit-data";
import { BioField, PurposeFields } from "../../src/profile-fields";
import { gateView, useLoad } from "../../src/screen";
import { validateBio, validatePurposes, type Purpose } from "../../src/shared";
import { ui } from "../../src/theme";
import { Button } from "../../src/ui";

// MOBILE-LIKES-001: the web's /mypage/profile (src/components/profile-edit.tsx, docs/43 §4.5). Only the bio and the
// purposes change here; the save sends the current name, gender and hobbies back unchanged (update_profile).
export default function ProfileEditScreen() {
  const { ready, signedIn, services } = useAuth();
  const router = useRouter();
  const { value } = useLoad((s) => loadProfileEdit(s.supabase), "profile-edit");
  const loaded = value?.status === "ok" ? value.profile : null;
  const [purposes, setPurposes] = useState<Purpose[]>([]);
  const [bio, setBio] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  useEffect(() => { if (loaded) { setPurposes(loaded.purposes); setBio(loaded.bio); } }, [loaded]);

  const blocked = gateView(ready, signedIn, !!services, value, LOAD_UNAVAILABLE, text.title);
  if (blocked) return blocked;
  if (!loaded) return <View style={ui.page} />;

  async function submit() {
    if (running.current || !services) return;
    if (!validateBio(bio)) { setError(text.bio); return; }
    if (!validatePurposes(purposes)) { setStatus(text.status.invalid); return; }
    setError(undefined); running.current = true; setBusy(true);
    let result: { status: ProfileEditStatus };
    try { result = await saveMyProfile(services.supabase, { bio, purposes }); } catch { result = { status: "unavailable" }; }
    setStatus(text.status[result.status]);
    running.current = false; setBusy(false);
  }

  return <ScrollView contentContainerStyle={ui.page} keyboardShouldPersistTaps="handled">
    <Button kind="small" label={text.back} style={{ alignSelf: "flex-start" }}
      onPress={() => { if (router.canGoBack()) router.back(); else router.replace("/mypage"); }} />
    <Text style={[ui.title, { marginTop: 16 }]} accessibilityRole="header">{text.title}</Text>
    <View style={ui.form}>
      <PurposeFields purposes={purposes} onChange={setPurposes} disabled={busy} />
      <BioField bio={bio} onChange={setBio} error={error} disabled={busy} />
      <Button testID="profile-edit-save" label={text.save} disabled={busy} busy={busy} onPress={() => void submit()} />
    </View>
    <Text testID="profile-edit-status" accessibilityLiveRegion="polite" style={[ui.message, { marginTop: 20, minHeight: 22 }]}>{status}</Text>
  </ScrollView>;
}
