import { useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useAuth } from "../../src/auth-context";
import { hideTargetKindLabel, LOAD_UNAVAILABLE, privacyText as text } from "../../src/messages";
import { gateView, useLoad } from "../../src/screen";
import {
  loadPrivacy, MAX_HIDDEN_TARGETS, samePrivacySettings, savePrivacy, TARGET_FIELDS,
  type HideTargetKind, type PrivacyFlag, type PrivacySaveStatus, type PrivacySettings,
} from "../../src/settings-data";
import { colors, ui } from "../../src/theme";
import { Button } from "../../src/ui";

const SECTIONS: { title: string; description: string; flags: PrivacyFlag[] }[] = [
  { title: text.hideTitle, description: text.hideDescription, flags: ["hideSameClass", "hideSameDepartment", "hideSameSchool"] },
  { title: text.academicTitle, description: text.academicDescription, flags: ["showDepartment", "showClass"] },
];
const KINDS: HideTargetKind[] = ["school", "department", "class"];

function SwitchRow({ flag, checked, onChange }: { flag: PrivacyFlag; checked: boolean; onChange: (next: boolean) => void }) {
  const [title, description] = text.rows[flag];
  return <Pressable testID={`privacy-${flag}`} accessibilityRole="switch" accessibilityLabel={title} accessibilityHint={description}
    accessibilityState={{ checked }} onPress={() => onChange(!checked)}
    style={{ minHeight: 64, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 16, paddingVertical: 14 }}>
    <View style={{ flex: 1 }}>
      <Text style={[ui.value, { fontSize: 16 }]}>{title}</Text>
      <Text style={[ui.hint, { marginTop: 4 }]}>{description}</Text>
    </View>
    <View style={{ width: 51, height: 31, borderRadius: 999, padding: 2, backgroundColor: checked ? colors.ink : "#e9e9eb", borderWidth: checked ? 0 : 1, borderColor: "#8a8a8e" }}>
      <View style={{ width: 27, height: 27, borderRadius: 999, backgroundColor: colors.white, marginLeft: checked ? 20 : 0 }} />
    </View>
  </Pressable>;
}

// MOBILE-004: the web's /settings/privacy (src/components/privacy-settings-live.tsx) through update_privacy_settings.
// The database checks the 50-target limit and the rate limit again; a success message never describes values that
// changed after the save started.
export default function PrivacyScreen() {
  const { ready, signedIn, services } = useAuth();
  const router = useRouter();
  const { value } = useLoad((s) => loadPrivacy(s.supabase), "privacy");
  const page = value?.status === "ok" ? value : null;
  const [draft, setDraft] = useState<PrivacySettings | null>(null);
  const [saved, setSaved] = useState<PrivacySettings | null>(null);
  const [status, setStatus] = useState<PrivacySaveStatus | "idle">("idle");
  const [panelOpen, setPanelOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const revision = useRef(0);
  const busy = useRef(false);

  useEffect(() => {
    if (page) { setDraft(page.settings); setSaved(page.settings); }
  }, [page]);

  const blocked = gateView(ready, signedIn, !!services, value, LOAD_UNAVAILABLE, text.title);
  if (blocked) return blocked;
  if (!page || !draft || !saved || !services) return <View style={ui.page} />;
  const current = draft;

  function update(next: PrivacySettings) {
    revision.current += 1;
    setDraft(next);
    setStatus("idle");
  }
  function toggleTarget(id: string, kind: HideTargetKind) {
    const field = TARGET_FIELDS[kind];
    const ids = current[field];
    update({ ...current, [field]: ids.includes(id) ? ids.filter((t) => t !== id) : [...ids, id] });
  }
  async function save() {
    if (busy.current || !services) return;
    busy.current = true;
    const savedRevision = revision.current;
    const snapshot = current;
    setSaving(true);
    try {
      const result = await savePrivacy(services.supabase, snapshot);
      if (result === "ok") setSaved(snapshot);
      if (revision.current === savedRevision) setStatus(result);
    } catch { setStatus("unavailable"); }
    finally { busy.current = false; setSaving(false); }
  }

  const count = Object.values(TARGET_FIELDS).reduce((total, field) => total + current[field].length, 0);
  const inactive = KINDS.some((kind) => current[TARGET_FIELDS[kind]].some((id) => !page.targets.some((t) => t.kind === kind && t.id === id)));
  const dirty = !samePrivacySettings(current, saved);
  const error = status === "idle" || status === "ok" ? "" : text.errors[status];

  return <View style={{ flex: 1, backgroundColor: colors.white }}>
    <ScrollView contentContainerStyle={ui.page}>
      <Button kind="small" label={text.back} style={{ alignSelf: "flex-start" }}
        onPress={() => { if (router.canGoBack()) router.back(); else router.replace("/mypage"); }} />
      <Text style={[ui.title, { marginTop: 16 }]} accessibilityRole="header">{text.title}</Text>
      <Text style={[ui.value, { marginTop: 24, fontSize: 22, lineHeight: 32 }]}>{text.lead}</Text>
      <Text style={[ui.note, { fontSize: 15, lineHeight: 26 }]}>{text.leadNote}</Text>
      {inactive ? <Text testID="privacy-inactive" style={ui.hint}>{text.inactive}</Text> : null}

      {SECTIONS.map((section) => <View key={section.title} style={ui.section} accessibilityLabel={section.title}>
        <Text style={ui.sectionTitle} accessibilityRole="header">{section.title}</Text>
        <Text style={ui.hint}>{section.description}</Text>
        <View style={{ borderRadius: 18, backgroundColor: colors.white, paddingHorizontal: 16 }}>
          {section.flags.map((flag) => <SwitchRow key={flag} flag={flag} checked={current[flag]} onChange={(next) => update({ ...current, [flag]: next })} />)}
        </View>
      </View>)}

      <View style={ui.section} accessibilityLabel={text.targetsTitle}>
        <Text style={ui.sectionTitle} accessibilityRole="header">{text.targetsTitle}</Text>
        <Text style={ui.hint}>{text.targetsDescription}</Text>
        <View style={{ borderRadius: 18, backgroundColor: colors.white }}>
          <Pressable testID="privacy-targets-toggle" accessibilityRole="button" accessibilityState={{ expanded: panelOpen }}
            onPress={() => setPanelOpen((open) => !open)} style={ui.listItem}>
            <Text style={[ui.value, { fontSize: 16 }]}>{text.manage}</Text>
            <Text testID="privacy-count" style={ui.term}>{count}{text.count}</Text>
          </Pressable>
          {panelOpen ? <View style={{ borderTopWidth: 1, borderColor: colors.line, paddingHorizontal: 16, paddingBottom: 8, paddingTop: 12 }}>
            <Text style={ui.term}>{text.limit}</Text>
            {KINDS.map((kind) => <View key={kind} style={{ marginTop: 12 }}>
              <Text style={[ui.term, { color: colors.inkSoft, fontWeight: "500" }]} accessibilityRole="header">{hideTargetKindLabel[kind]}</Text>
              {page.targets.filter((t) => t.kind === kind).map((target, index) => {
                const selected = current[TARGET_FIELDS[kind]].includes(target.id);
                return <View key={target.id} style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, paddingVertical: 8 }}>
                  <Text style={[ui.value, { flex: 1 }]}>{target.label}{selected ? <Text style={ui.term}>{`  ${text.selected}`}</Text> : null}</Text>
                  <Button testID={`privacy-target-${kind}-${index}`} kind="small" label={selected ? text.remove : text.add}
                    disabled={!selected && count >= MAX_HIDDEN_TARGETS} onPress={() => toggleTarget(target.id, kind)} />
                </View>;
              })}
            </View>)}
          </View> : null}
        </View>
      </View>
    </ScrollView>

    <View accessibilityLabel="設定の保存" style={[ui.composer, { gap: 8 }]}>
      <Text testID="privacy-status" accessibilityLiveRegion="polite" style={[ui.term, { textAlign: "center" }]}>
        {status === "ok" ? text.saved : status === "idle" && dirty ? text.dirty : ""}
      </Text>
      {error ? <Text testID="privacy-error" accessibilityRole="alert" style={[ui.message, { textAlign: "center", fontWeight: "500" }]}>{error}</Text> : null}
      <Button testID="privacy-save" label={text.save} disabled={saving} busy={saving} onPress={() => void save()} />
      <Text style={[ui.term, { textAlign: "center", fontSize: 12 }]}>{text.limit}</Text>
    </View>
  </View>;
}
