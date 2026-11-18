import { Link, Redirect, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View, type ScrollViewInstance } from "react-native";
import { listMyPhotos } from "../src/account-data";
import { useAuth } from "../src/auth-context";
import { logoutText, onboardingText as text, UNAVAILABLE } from "../src/messages";
import {
  birthDateOf, completeOnboarding, loadOnboarding, saveOnboarding, type CompleteOnboardingResult, type OnboardingResult, type OnboardingStart,
} from "../src/onboarding-data";
import { PhotoManager } from "../src/photo-manager";
import { BioField, PurposeFields } from "../src/profile-fields";
import { purposeText, validateBio, validateBirthDate, validateDisplayName, validateGender, validatePurposes, type Purpose } from "../src/shared";
import { colors, ui } from "../src/theme";
import { Alert, Button, Choice, FieldError, SessionExpired } from "../src/ui";

type Errors = Record<string, string>;

function adultBirthDate(birth: string): boolean {
  try {
    return validateBirthDate(birth, new Date());
  } catch {
    return false;
  }
}

// MOBILE-002: the web's src/components/onboarding.tsx (backend mode) on the device. The same steps, checks, messages
// and RPCs in the same order (src/onboarding-data.ts); photos are registered after the first save, as on the web.
// MOBILE-LIKES-001 (docs/43 §4.4): step 4 is the optional purposes and the one optional bio (no modes).
export default function OnboardingScreen() {
  const { ready, signedIn, services, signOut } = useAuth();
  const router = useRouter();
  const [start, setStart] = useState<OnboardingStart | null>(null);
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [gender, setGender] = useState("");
  const [year, setYear] = useState("");
  const [month, setMonth] = useState("");
  const [day, setDay] = useState("");
  const [adult, setAdult] = useState(false);
  const [school, setSchool] = useState("");
  const [dept, setDept] = useState("");
  const [cls, setCls] = useState("");
  const [purposes, setPurposes] = useState<Purpose[]>([]);
  const [bio, setBio] = useState("");
  const [errors, setErrors] = useState<Errors>({});
  const [result, setResult] = useState<OnboardingResult | null>(null);
  const [pending, setPending] = useState(false);
  const [registeredPhotos, setRegisteredPhotos] = useState<string[]>([]);
  const [photoPending, setPhotoPending] = useState(false);
  const [completion, setCompletion] = useState<CompleteOnboardingResult | null>(null);
  const [leaving, setLeaving] = useState(false);
  const saving = useRef(false);
  const scroll = useRef<ScrollViewInstance>(null);

  useEffect(() => {
    if (!services || !signedIn) return;
    let active = true;
    void loadOnboarding(services.supabase, listMyPhotos).then((value) => {
      if (!active) return;
      setStart(value);
      if (value.status === "ok" && value.initialPhotos) {
        setRegisteredPhotos(value.initialPhotos);
        setStep(5);
      }
    });
    return () => { active = false; };
  }, [services, signedIn]);
  useEffect(() => { scroll.current?.scrollTo?.({ y: 0, animated: false }); }, [step]);

  // FIX-007: every step, the photo step included, can be left. "ログアウト" ends this device's session as the other
  // screens do (src/auth-context.tsx: the Keychain session and the image memory cache are cleared) and opens the
  // welcome screen; the saved profile stays, so no confirmation is asked. The screen shows nothing while it ends.
  async function leave() {
    if (leaving || saving.current) return;
    setLeaving(true);
    await signOut().catch(() => {});
    router.replace("/");
  }
  const signOutLink = (disabled: boolean) => <Pressable testID="onboarding-sign-out" accessibilityRole="button" accessibilityState={{ disabled }}
    disabled={disabled} onPress={() => void leave()} style={[ui.textLink, { alignSelf: "center" }, disabled && ui.disabled]}>
    <Text style={[ui.textLinkText, { color: colors.muted }]}>{logoutText.local}</Text>
  </Pressable>;

  if (!ready || leaving) return <View style={ui.page} />;
  if (!signedIn) return <Redirect href="/" />;
  if (start?.status === "completed") return <Redirect href="/mypage" />;
  if (!start && services) return <View style={ui.page} />;
  if (!start || start.status !== "ok") {
    return <ScrollView contentContainerStyle={ui.page}>
      <Text style={ui.brand}>Campus Link</Text>
      {start?.status === "unauthenticated" ? <SessionExpired /> :
        <Text testID="onboarding-unavailable" style={ui.message} accessibilityRole="alert">{UNAVAILABLE}</Text>}
      {signOutLink(false)}
    </ScrollView>;
  }

  const affiliations = start.master;
  const selectedSchool = affiliations.find((s) => s.id === school);
  const selectedDept = selectedSchool?.departments.find((d) => d.id === dept);
  const selectedClass = selectedDept?.classes.find((c) => c.id === cls);
  const birth = birthDateOf(year, month, day);

  function move(next: number) { setErrors({}); setResult(null); setStep(next); }
  function editDetails() { setCompletion(null); move(0); }
  function checkStep(index: number): Errors {
    const next: Errors = {};
    if (index === 0) {
      if (!validateDisplayName(name)) next.name = text.fields.name;
      if (!validateGender(gender)) next.gender = text.fields.gender;
      if (!adultBirthDate(birth)) next.birth = text.fields.birth;
      if (!adult) next.adult = text.fields.adult;
    }
    if (index === 1 && !selectedClass) next[!selectedSchool ? "school" : !selectedDept ? "dept" : "cls"] = text.fields.affiliation;
    if (index === 3) {
      if (!validatePurposes(purposes)) next.purposes = text.fields.purposes;
      if (!validateBio(bio)) next.bio = text.fields.bio;
    }
    return next;
  }
  async function submit() {
    if (saving.current || !services) return;
    // Recheck all steps at confirmation, including the current JST date.
    const indexes = step === 4 ? [0, 1, 2, 3] : [step];
    for (const index of indexes) {
      const next = checkStep(index);
      if (Object.keys(next).length) { setStep(index); setErrors(next); return; }
    }
    if (step !== 4) { move(step + 1); return; }
    saving.current = true;
    setPending(true);
    setResult(null);
    try {
      const outcome = await saveOnboarding(services.supabase, {
        displayName: name, gender, birthDate: birth, adultDeclared: adult, schoolId: school, departmentId: dept, classId: cls, purposes, bio,
      });
      setResult(outcome);
      if (outcome.status === "completed" || outcome.status === "saved_needs_photo") setStep(5);
      else if (outcome.status === "invalid" && Number.isInteger(outcome.step) && outcome.step! >= 0 && outcome.step! <= 3) setStep(outcome.step!);
    } catch {
      setResult({ status: "unavailable" });
    } finally {
      saving.current = false;
      setPending(false);
    }
  }
  async function complete() {
    if (saving.current || photoPending || registeredPhotos.length === 0 || !services) return;
    saving.current = true; setPending(true); setCompletion(null);
    try {
      const outcome = await completeOnboarding(services.supabase);
      setCompletion(outcome);
      if (outcome.status === "completed") setResult({ status: "completed" });
    } catch { setCompletion({ status: "unavailable" }); } finally {
      saving.current = false; setPending(false);
    }
  }

  const status = completion?.status ?? result?.status;
  const message = status && status !== "completed" && status !== "saved_needs_photo" ? text.status[status] : "";
  const genderLabel = text.genders[gender as keyof typeof text.genders];
  const editLink = <Button kind="small" label="入力内容を修正する" disabled={pending} onPress={editDetails} style={{ alignSelf: "flex-start" }} />;

  return <ScrollView ref={scroll} contentContainerStyle={ui.page} keyboardShouldPersistTaps="handled">
    <Text style={ui.brand}>Campus Link</Text>
    {step < 4 ? <Text style={ui.step} accessibilityLabel={`ステップ ${step + 1} / 4`}>{step + 1} / 4</Text> : null}
    <Text testID="onboarding-title" style={ui.title} accessibilityRole="header">{step === 5 ? text.saveTitle : text.titles[step]}</Text>
    {status === "unauthenticated" ? <SessionExpired /> : message ? <Alert testID="onboarding-message">
      <Text style={ui.message}>{message}</Text>
      {status === "needs_details" ? editLink : null}
    </Alert> : null}

    {step === 5 ? <View style={ui.form}>
      {result?.status === "completed" ? <>
        <Text style={ui.body}>{text.created}</Text>
        <Link href="/verification" replace style={ui.textLink}><Text style={ui.textLinkText}>在学・年齢確認へ</Text></Link>
        <Link href="/mypage" replace style={ui.textLink}><Text style={ui.textLinkText}>マイページへ</Text></Link>
      </> : <>
        <Text style={ui.body}>{text.saved}</Text>
        <PhotoManager initial={registeredPhotos} onChange={setRegisteredPhotos} onPendingChange={setPhotoPending} disabled={pending} />
        <Button testID="onboarding-complete" label="プロフィールを完成" busy={pending}
          disabled={pending || photoPending || registeredPhotos.length === 0} onPress={() => void complete()} />
        {status !== "needs_details" ? editLink : null}
      </>}
    </View> : <View style={ui.form}>
      {step === 0 ? <>
        <View>
          <Text style={ui.label}>表示名</Text>
          <TextInput testID="onboarding-name" style={ui.input} value={name} onChangeText={setName} accessibilityLabel="表示名"
            autoCorrect={false} editable={!pending} />
          <FieldError message={errors.name} />
        </View>
        <View accessibilityRole="radiogroup" accessibilityLabel="性別">
          <Text style={ui.label}>性別</Text>
          <Text style={ui.hint}>{text.genderNote}</Text>
          <View style={ui.row}>{Object.entries(text.genders).map(([value, label]) =>
            <Choice key={value} testID={`gender-${value}`} label={label} selected={gender === value} onPress={() => setGender(value)} />)}</View>
          <FieldError message={errors.gender} />
        </View>
        <View>
          <Text style={ui.label}>生年月日</Text>
          <View style={ui.dateRow}>
            {([["年", year, setYear, 4, "birth-year"], ["月", month, setMonth, 2, "birth-month"], ["日", day, setDay, 2, "birth-day"]] as const).map(([unit, value, set, length, id]) =>
              <View key={unit} style={ui.dateInput}>
                <TextInput testID={id} style={ui.input} value={value} onChangeText={(next) => set(next.replace(/\D/g, ""))} keyboardType="number-pad"
                  maxLength={length} accessibilityLabel={`生年月日の${unit}`} editable={!pending} />
                <Text style={ui.hint}>{unit}</Text>
              </View>)}
          </View>
          <FieldError message={errors.birth} />
        </View>
        <View>
          <Choice testID="onboarding-adult" role="checkbox" label={text.adult} selected={adult} onPress={() => setAdult((value) => !value)} />
          <FieldError message={errors.adult} />
        </View>
      </> : null}

      {step === 1 ? <>
        <Text style={ui.hint}>{text.affiliationNote}</Text>
        <View accessibilityRole="radiogroup" accessibilityLabel="学校">
          <Text style={ui.label}>学校</Text>
          <View style={ui.row}>{affiliations.map((s) => <Choice key={s.id} testID={`school-${s.id}`} label={s.name} selected={school === s.id}
            onPress={() => { setSchool(s.id); setDept(""); setCls(""); }} />)}</View>
          <FieldError message={errors.school} />
        </View>
        <View accessibilityRole="radiogroup" accessibilityLabel="学科">
          <Text style={ui.label}>学科</Text>
          {selectedSchool ? <View style={ui.row}>{selectedSchool.departments.map((d) => <Choice key={d.id} testID={`dept-${d.id}`} label={d.name}
            selected={dept === d.id} onPress={() => { setDept(d.id); setCls(""); }} />)}</View> : <Text style={ui.hint}>{text.choose}</Text>}
          <FieldError message={errors.dept} />
        </View>
        <View accessibilityRole="radiogroup" accessibilityLabel="クラス">
          <Text style={ui.label}>クラス</Text>
          {selectedDept ? <View style={ui.row}>{selectedDept.classes.map((c) => <Choice key={c.id} testID={`class-${c.id}`} label={c.name}
            selected={cls === c.id} onPress={() => setCls(c.id)} />)}</View> : <Text style={ui.hint}>{text.choose}</Text>}
          <FieldError message={errors.cls} />
        </View>
      </> : null}

      {step === 2 ? <Text style={ui.body}>{text.photoLater}</Text> : null}

      {step === 3 ? <>
        <PurposeFields purposes={purposes} onChange={setPurposes} error={errors.purposes} disabled={pending} />
        <BioField bio={bio} onChange={setBio} error={errors.bio} disabled={pending} />
      </> : null}

      {step === 4 ? <View>
        {[
          <View key="basic" style={{ gap: 6 }}>
            <Text style={ui.term}>表示名</Text><Text style={ui.value}>{name}</Text>
            <Text style={ui.term}>性別</Text><Text style={ui.value}>{genderLabel}</Text>
            <Text style={ui.term}>生年月日</Text><Text style={ui.value}>{birth}</Text>
            <Text style={ui.term}>{text.adult}</Text><Text style={ui.value}>{adult ? text.adultConfirmed : text.adultUnconfirmed}</Text>
          </View>,
          <View key="affiliation" style={{ gap: 6 }}>
            <Text style={ui.term}>学校</Text><Text style={ui.value}>{selectedSchool?.name}</Text>
            <Text style={ui.term}>学科</Text><Text style={ui.value}>{selectedDept?.name}</Text>
            <Text style={ui.term}>クラス</Text><Text style={ui.value}>{selectedClass?.name}</Text>
          </View>,
          null,
          <View key="purposes" style={{ gap: 6 }}>
            <Text style={ui.term}>{text.purposesTerm}</Text><Text testID="confirm-purposes" style={ui.value}>{purposes.length ? purposeText(purposes) : text.noPurposes}</Text>
            <Text style={ui.term}>{text.bioTerm}</Text><Text testID="confirm-bio" style={ui.value}>{bio || text.noBio}</Text>
          </View>,
        ].map((content, i) => content ? <View key={i} accessibilityLabel={`${text.titles[i]}の確認`} style={ui.section}>
          <Text style={ui.sectionTitle}>{text.titles[i]}</Text>
          {content}
          <Button kind="small" label={`${text.titles[i]}を編集`} disabled={pending} onPress={() => move(i)} style={{ alignSelf: "flex-start" }} />
        </View> : null)}
      </View> : null}

      <View style={[ui.rowTight, { marginTop: 8 }]}>
        {step > 0 ? <Button testID="onboarding-back" kind="secondary" label="戻る" disabled={pending} onPress={() => move(step - 1)} /> : null}
        <Button testID="onboarding-next" label={step === 4 ? "プロフィールを保存" : step === 3 ? "確認へ" : "次へ"} busy={pending && step === 4}
          disabled={pending} onPress={() => void submit()} style={{ flex: 1 }} />
      </View>
    </View>}
    {signOutLink(pending || photoPending)}
  </ScrollView>;
}
