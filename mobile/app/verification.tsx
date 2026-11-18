import { Link, Redirect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import {
  loadMyVerification, submitVerification, SYNTHETIC_SAMPLES, withdrawVerification, type Failure, type VerificationResult, type VerificationState,
} from "../src/account-data";
import { useAuth } from "../src/auth-context";
import { LOAD_UNAVAILABLE, verificationText as text } from "../src/messages";
import { reasonLabel } from "../src/shared";
import { ui } from "../src/theme";
import { Alert, Button, Choice, SessionExpired } from "../src/ui";

type Kind = "age" | "enrollment";
const KINDS: Kind[] = ["age", "enrollment"];

function expiry(value: string | null) {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  try {
    return new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "long", day: "numeric" }).format(new Date(value)) + "まで";
  } catch {
    return null;
  }
}

// MOBILE-002: the web's src/components/verification-live.tsx on the device. Only the synthetic samples can be
// submitted (docs/42 §2 #6); there is no document upload of any kind.
export default function VerificationScreen() {
  const { ready, signedIn, services } = useAuth();
  const [state, setState] = useState<VerificationState | Failure | null>(null);
  const lock = useRef(false);
  const [pending, setPending] = useState(false);
  const [refs, setRefs] = useState<Record<Kind, string[]>>({ age: [], enrollment: [] });
  const [message, setMessage] = useState("");
  const [error, setError] = useState<Exclude<VerificationResult["status"], "ok"> | null>(null);

  const reload = useCallback(async () => {
    if (!services) return;
    setState(await loadMyVerification(services.supabase));
  }, [services]);
  useEffect(() => { if (signedIn) void reload(); }, [signedIn, reload]);

  if (!ready) return <View style={ui.page} />;
  if (!signedIn) return <Redirect href="/" />;
  if (!state && services) return <View style={ui.page} />;

  async function act(kind: Kind, id?: string) {
    if (lock.current || !services) return;
    lock.current = true; setPending(true); setError(null); setMessage("");
    try {
      const r = id ? await withdrawVerification(services.supabase, id) : await submitVerification(services.supabase, kind, refs[kind]);
      if (r.status === "ok") { setMessage(`${text.kinds[kind]}を${id ? "取り下げました" : "提出しました"}。`); await reload(); }
      else { setError(r.status); if (r.status === "invalid_state") await reload(); }
    } catch { setError("unavailable"); } finally { lock.current = false; setPending(false); }
  }

  const back = <Link href="/mypage" replace style={ui.textLink}><Text style={ui.textLinkText}>マイページへ戻る</Text></Link>;
  if (!state || state.status !== "ok") {
    return <ScrollView contentContainerStyle={ui.page}>
      <Text style={ui.brand}>Campus Link</Text>
      {state?.status === "unauthenticated" ? <SessionExpired /> :
        <Text testID="verification-unavailable" style={ui.message} accessibilityRole="alert">{LOAD_UNAVAILABLE}</Text>}
      {back}
    </ScrollView>;
  }

  return <ScrollView contentContainerStyle={ui.page} accessibilityState={{ busy: pending }}>
    {back}
    <Text style={ui.notice}>{text.notice}</Text>
    <Text style={[ui.title, { marginTop: 24 }]} accessibilityRole="header">{text.title}</Text>
    {message ? <Text testID="verification-status" style={[ui.message, { marginTop: 16 }]} accessibilityLiveRegion="polite">{message}</Text> : null}
    {error === "unauthenticated" ? <SessionExpired /> : error ? <Alert testID="verification-error"><Text style={ui.message}>{text.errors[error]}</Text></Alert> : null}
    {!state.account.has_profile ? <View style={{ marginTop: 24 }}>
      <Text style={ui.body}>{text.needsProfile}</Text>
      <Link href="/onboarding" replace style={ui.textLink}><Text style={ui.textLinkText}>プロフィールを作成</Text></Link>
    </View> : KINDS.map((kind) => {
      const row = state[kind];
      const unfinished = row?.status === "submitted" || row?.status === "in_review";
      const verified = kind === "age" ? state.account.age_verified : state.account.affiliation_confirmed;
      const missing = kind === "enrollment" && state.account.affiliation_status === null;
      return <View key={kind} testID={`verification-${kind}`} accessibilityLabel={text.kinds[kind]} style={ui.outlined}>
        <View style={[ui.rowTight, { justifyContent: "space-between", alignItems: "center" }]}>
          <Text style={[ui.sectionTitle, { fontSize: 20 }]} accessibilityRole="header">{text.kinds[kind]}</Text>
          <Text testID={`verification-${kind}-label`} style={ui.badge}>{row ? text.labels[row.status] : text.none}</Text>
        </View>
        {missing ? <View>
          <Text style={ui.body}>{text.needsAffiliation}</Text>
          <Link href="/onboarding" replace style={ui.textLink}><Text style={ui.textLinkText}>所属を登録</Text></Link>
        </View> : <>
          {verified ? <Text style={ui.body}>{text.verified}{kind === "enrollment" && row?.status === "approved" ? expiry(row.valid_until) : null}</Text> : null}
          {row && ["rejected", "revoked", "superseded"].includes(row.status) ? <Text style={ui.body}>{reasonLabel(row.decision_reason)}</Text> : null}
          {!(kind === "age" && verified) ? <View style={{ gap: 12 }}>
            <Text style={ui.label}>架空の資料を選択</Text>
            {SYNTHETIC_SAMPLES.map((ref, i) => <Choice key={ref} testID={`sample-${kind}-${i + 1}`} role="checkbox" label={`架空のサンプル資料${i + 1}`}
              selected={refs[kind].includes(ref)} disabled={pending}
              onPress={() => setRefs((prev) => ({ ...prev, [kind]: prev[kind].includes(ref) ? prev[kind].filter((r) => r !== ref) : [...prev[kind], ref] }))} />)}
            <View style={ui.rowTight}>
              <Button testID={`submit-${kind}`} label="提出" disabled={pending || unfinished} busy={pending} onPress={() => void act(kind)} />
              {row?.status === "submitted" ? <Button testID={`withdraw-${kind}`} kind="secondary" label="取り下げ" disabled={pending}
                onPress={() => void act(kind, row.id)} /> : null}
            </View>
            {row?.status === "in_review" ? <Text style={ui.body}>{text.inReview}</Text> : null}
          </View> : null}
        </>}
      </View>;
    })}
  </ScrollView>;
}
