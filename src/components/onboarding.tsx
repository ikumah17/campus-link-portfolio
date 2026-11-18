"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { DemoShell, inputClass, primaryButton, secondaryButton, textLink } from "@/components/auth-demo-form";
import { demoAffiliations, demoPhotos } from "@/data/demo-affiliations";
import { codePointLength, PURPOSE_LABELS, PURPOSES, purposeText, validateAffiliation, validateBio, validateBirthDate, validateDisplayName, validateGender, validatePhotos, validatePurposes, type Purpose } from "@/lib/onboarding-validation";
import type { OnboardingResult, CompleteOnboardingResult } from "@/server/onboarding-actions";
import { PhotoManager } from "@/components/photo-manager";
import type { Affiliation } from "@/server/affiliation-master";
import { pageTitle } from "@/components/ui-tokens";

const titles = ["基本情報", "所属", "写真", "目的と自己紹介", "入力内容の確認", "デモの完了"];
const genders = { female: "女性", male: "男性", other: "その他" };
type Errors = Record<string, string>;

export function Onboarding({ backend }: { backend?: { master: Affiliation[]; initialPhotos?: string[] } }) {
  const [step, setStep] = useState(backend?.initialPhotos ? 5 : 0);
  const [name, setName] = useState("");
  const [gender, setGender] = useState("");
  const [birth, setBirth] = useState("");
  const [adult, setAdult] = useState(false);
  const [school, setSchool] = useState("");
  const [dept, setDept] = useState("");
  const [cls, setCls] = useState("");
  const [photos, setPhotos] = useState<string[]>([]);
  const [purposes, setPurposes] = useState<Purpose[]>([]);
  const [bio, setBio] = useState("");
  const [errors, setErrors] = useState<Errors>({});
  const [result, setResult] = useState<OnboardingResult | null>(null);
  const [pending, setPending] = useState(false);
  const [registeredPhotos, setRegisteredPhotos] = useState<string[]>(backend?.initialPhotos ?? []);
  const [photoPending, setPhotoPending] = useState(false);
  const [completion, setCompletion] = useState<CompleteOnboardingResult | null>(null);
  const saving = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const affiliations = backend?.master ?? demoAffiliations;
  const selectedSchool = affiliations.find((s) => s.id === school);
  const selectedDept = selectedSchool?.departments.find((d) => d.id === dept);
  const selectedClass = selectedDept?.classes.find((c) => c.id === cls);
  useEffect(() => { heading.current?.focus(); }, [step]);

  function move(next: number) { setErrors({}); setResult(null); setStep(next); }
  function editDetails() { setCompletion(null); move(0); }
  function checkStep(index: number): Errors {
    const next: Errors = {};
    if (index === 0) {
      if (!validateDisplayName(name)) next.name = "表示名は空白のみを除く1〜20文字で入力してください。";
      if (!validateGender(gender)) next.gender = "性別を選んでください。";
      if (!validateBirthDate(birth, new Date())) next.birth = "18歳以上となる正しい生年月日を入力してください（1900年1月1日より後）。";
      if (!adult) next.adult = "18歳以上であることを確認してください。";
    }
    if (index === 1 && (backend ? !selectedClass : !validateAffiliation(school, dept, cls))) {
      next[!selectedSchool ? "school" : !selectedDept ? "dept" : "cls"] = "学校・学科・クラスを順に選んでください。";
    }
    if (index === 2 && !backend && !validatePhotos(photos)) next.photos = "架空の写真を1〜3枚選んでください。";
    if (index === 3) {
      if (!validatePurposes(purposes)) next.purposes = "目的を選び直してください。";
      if (!validateBio(bio)) next.bio = "自己紹介は500文字以内で入力してください。";
    }
    return next;
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (saving.current) return;
    // Recheck all steps at confirmation, including the current JST date.
    const indexes = step === 4 ? [0, 1, 2, 3] : [step];
    for (const index of indexes) {
      const next = checkStep(index);
      if (Object.keys(next).length) {
        setStep(index); setErrors(next);
        // Wait for the invalid step and its error descriptions to render.
        requestAnimationFrame(() => form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
        return;
      }
    }
    if (!backend || step !== 4) { move(step + 1); return; }
    saving.current = true;
    setPending(true);
    setResult(null);
    try {
      const { saveOnboarding } = await import("@/server/onboarding-actions");
      const outcome = await saveOnboarding({ displayName: name, gender, birthDate: birth, adultDeclared: adult, schoolId: school, departmentId: dept, classId: cls, purposes, bio });
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
  const invalid = (key: string) => ({ "aria-invalid": !!errors[key], "aria-describedby": errors[key] ? `${key}-error` : undefined });
  async function complete() {
    if (saving.current || photoPending || registeredPhotos.length === 0) return;
    saving.current = true; setPending(true); setCompletion(null);
    try {
      const { completeOnboarding } = await import("@/server/onboarding-actions");
      const outcome = await completeOnboarding();
      setCompletion(outcome);
      if (outcome.status === "completed") setResult({ status: "completed" });
    } catch { setCompletion({ status: "unavailable" }); } finally {
      saving.current = false; setPending(false);
    }
  }
  const error = (key: string) => errors[key] ? <p id={`${key}-error`} className="mt-2 text-sm">{errors[key]}</p> : null;
  const photoButton = (id: string) => {
    const photo = demoPhotos.find((p) => p.id === id)!;
    const order = photos.indexOf(id);
    const label = order < 0 ? "選択する" : `${order + 1}${order === 0 ? "・メイン" : "・選択中"}`;
    return <button key={id} type="button" aria-label={`${label}（写真${demoPhotos.indexOf(photo) + 1}）`} aria-pressed={order >= 0} {...invalid("photos")} onClick={() => setPhotos((prev) => prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id])} className={`min-h-11 min-w-11 overflow-hidden rounded-[18px] border-2 p-1 ${order >= 0 ? "border-ink" : "border-line"}`}>
      <img src={photo.src} alt={photo.alt} width={160} height={180} className="aspect-[4/5] w-full rounded-[12px] object-cover" />
      <span className="block py-2 text-[12px]">{label}</span>
    </button>;
  };
  const status = completion?.status ?? result?.status;
  const message = status === "needs_photo" ? "写真を1枚以上登録してください。" :
    status === "needs_details" || status === "invalid" ? "入力内容を確認してください。" :
    status === "birth_locked" ? "年齢確認後は生年月日を変更できません。" :
    status === "unauthenticated" ? "ログインの有効期限が切れました。" :
    status === "unavailable" ? "現在保存できません。時間をおいて再度お試しください。" : "";
  return <DemoShell notice={!backend}>
    {step < 4 && <p className="mb-3 text-[13px] text-muted" aria-label="ステップ">{step + 1} / 4</p>}
    <h1 ref={heading} tabIndex={-1} className={pageTitle}>{backend && step === 5 ? "プロフィールの保存" : titles[step]}</h1>
    {message && <div role="alert" className="mt-6 text-sm"><p>{message}</p>{status === "unauthenticated" && <Link href="/login?next=/onboarding" className={textLink}>ログインへ</Link>}{status === "needs_details" && <Link href="/onboarding?edit=1" onClick={editDetails} className={textLink}>入力内容を修正する</Link>}</div>}
    {step === 5 ? backend ? <div className="mt-6 space-y-6">
      {result?.status === "completed" ? <><p className="leading-7">プロフィールを作成しました。</p><Link href="/verification" className={textLink}>在学・年齢確認へ</Link></> : <>
        <p className="leading-7">プロフィールを保存しました。写真を1枚以上登録してください。</p>
        <PhotoManager initial={backend.initialPhotos ?? []} onChange={setRegisteredPhotos} onPendingChange={setPhotoPending} disabled={pending} />
        <button type="button" disabled={pending || photoPending || registeredPhotos.length === 0} aria-busy={pending} onClick={() => { void complete(); }} className={primaryButton}>プロフィールを完成</button>
        {status !== "needs_details" && <Link href="/onboarding?edit=1" onClick={editDetails} className={textLink}>入力内容を修正する</Link>}
      </>}
    </div> : <div className="mt-6 space-y-6">
      <p className="leading-7">デモのため保存されていません。在学・年齢確認は今後の工程です。</p>
      <Link href="/" className={primaryButton}>架空のプロフィールを見る</Link>
      <Link href="/verification" className={textLink}>在学・年齢確認へ（デモ）</Link>
    </div> : <form ref={form} noValidate autoComplete="off" onSubmit={submit} className="mt-8 space-y-7">
      {step === 0 && <>
        <div><label htmlFor="onboarding-name">表示名</label><input id="onboarding-name" value={name} onChange={(e) => setName(e.target.value)} {...invalid("name")} className={inputClass} />{error("name")}</div>
        <fieldset><legend>性別</legend><p id="gender-note" className="mt-2 text-[13px] text-muted">性別はプロフィールに公開されます。</p>
          <div className="mt-3 flex flex-wrap gap-3">{Object.entries(genders).map(([value, label]) => <label key={value} className="flex min-h-12 min-w-20 items-center gap-2 rounded-full border border-line px-4"><input type="radio" name="gender" value={value} checked={gender === value} onChange={() => setGender(value)} {...invalid("gender")} aria-describedby={`gender-note${errors.gender ? " gender-error" : ""}`} />{label}</label>)}</div>{error("gender")}
        </fieldset>
        <div><label htmlFor="onboarding-birth">生年月日</label><input id="onboarding-birth" type="date" value={birth} onChange={(e) => setBirth(e.target.value)} {...invalid("birth")} className={inputClass} />{error("birth")}</div>
        <div><label className="flex min-h-12 items-center gap-3"><input type="checkbox" checked={adult} onChange={(e) => setAdult(e.target.checked)} {...invalid("adult")} />18歳以上です</label>{error("adult")}</div>
      </>}
      {step === 1 && <>
        <p className="text-[13px] leading-6 text-muted">学校はプロフィールに公開されます。学科・クラスの公開は公開範囲設定で選べます（既定は非公開）。</p>
        <div><label htmlFor="school">学校</label><select id="school" value={school} onChange={(e) => { setSchool(e.target.value); setDept(""); setCls(""); }} {...invalid("school")} className={inputClass}><option value="">選んでください</option>{affiliations.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>{error("school")}</div>
        <div><label htmlFor="dept">学科</label><select id="dept" disabled={!school} value={dept} onChange={(e) => { setDept(e.target.value); setCls(""); }} {...invalid("dept")} className={inputClass}><option value="">選んでください</option>{selectedSchool?.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>{error("dept")}</div>
        <div><label htmlFor="cls">クラス</label><select id="cls" disabled={!dept} value={cls} onChange={(e) => setCls(e.target.value)} {...invalid("cls")} className={inputClass}><option value="">選んでください</option>{selectedDept?.classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>{error("cls")}</div>
      </>}
      {step === 2 && (backend ? <p className="text-[14px] leading-6 text-muted">写真は、次の保存のあとで登録します。</p> : <>
        <p className="text-[14px] leading-6 text-muted">架空の写真を1〜3枚選んでください。選択順の1枚目がメイン写真です。</p>
        <div className="grid grid-cols-3 gap-3">{demoPhotos.map((p) => photoButton(p.id))}</div>{error("photos")}
        <ol aria-label="写真の選択順" className="space-y-2 text-sm">{photos.map((id, i) => <li key={id}>{i + 1}. {demoPhotos.find((p) => p.id === id)!.alt}{i === 0 ? "（メイン）" : ""}</li>)}</ol>
      </>)}
      {step === 3 && <>
        <PurposeFields purposes={purposes} onChange={setPurposes} error={errors.purposes} />
        <BioField bio={bio} onChange={setBio} error={errors.bio} />
      </>}
      {step === 4 && <div className="space-y-6">
        {[
          <dl key="basic" className="space-y-2 break-words"><dt>表示名</dt><dd>{name}</dd><dt>性別</dt><dd>{genders[gender as keyof typeof genders]}</dd><dt>生年月日</dt><dd>{birth}</dd><dt>18歳以上です</dt><dd>{adult ? backend ? "確認しました" : "確認しました（デモ）" : "未確認"}</dd></dl>,
          <dl key="affiliation" className="space-y-2"><dt>学校</dt><dd>{selectedSchool?.name}</dd><dt>学科</dt><dd>{selectedDept?.name}</dd><dt>クラス</dt><dd>{selectedClass?.name}</dd></dl>,
          <ol key="photos" className="space-y-3">{photos.map((id, i) => { const p = demoPhotos.find((photo) => photo.id === id)!; return <li key={id} className="flex items-center gap-4"><img src={p.src} alt={p.alt} width={56} height={70} className="rounded-lg" /><span>{i + 1}. {p.alt}{i === 0 ? "（メイン）" : ""}</span></li>; })}</ol>,
          <dl key="purposes" className="space-y-2 break-words"><dt>目的</dt><dd>{purposes.length ? purposeText(purposes) : "未選択"}</dd><dt>自己紹介</dt><dd className="whitespace-pre-wrap">{bio || "自己紹介なし"}</dd></dl>,
        ].map((content, i) => backend && i === 2 ? null : <section key={i} aria-label={`${titles[i]}の確認`} className="rounded-[20px] bg-surface p-5"><h2 className="mb-4 font-medium">{titles[i]}</h2>{content}<button type="button" disabled={pending} onClick={() => move(i)} className={textLink}>{titles[i]}を編集</button></section>)}
      </div>}
      <div className="flex gap-3 pt-3">
        {step > 0 && <button type="button" disabled={pending} onClick={() => move(step - 1)} className={secondaryButton}>戻る</button>}
        <button type="submit" disabled={pending} aria-busy={backend && step === 4 ? pending : undefined} className={`${primaryButton} flex-1`}>{step === 4 ? backend ? "プロフィールを保存" : "デモのプロフィールを作成" : step === 3 ? "確認へ" : "次へ"}</button>
      </div>
    </form>}
  </DemoShell>;
}

// The optional purposes and the one bio (docs/43 §4.4), shared with the profile edit screen.
export function PurposeFields({ purposes, onChange, error, disabled = false }: { purposes: Purpose[]; onChange: (next: Purpose[]) => void; error?: string; disabled?: boolean }) {
  return <fieldset disabled={disabled} aria-describedby={`purposes-note${error ? " purposes-error" : ""}`}><legend>目的（任意・いくつでも）</legend>
    <p id="purposes-note" className="mt-2 text-[13px] text-muted">プロフィールに表示されます。選ばなくてもかまいません。</p>
    <div className="mt-3 flex flex-col gap-3">{PURPOSES.map((p) => <label key={p} className="flex min-h-12 items-center gap-3 rounded-full border border-line px-4"><input type="checkbox" checked={purposes.includes(p)} aria-invalid={!!error} onChange={() => onChange(purposes.includes(p) ? purposes.filter((v) => v !== p) : PURPOSES.filter((v) => v === p || purposes.includes(v)))} />{PURPOSE_LABELS[p]}</label>)}</div>
    {error && <p id="purposes-error" className="mt-2 text-sm">{error}</p>}
  </fieldset>;
}
export function BioField({ bio, onChange, error, disabled = false }: { bio: string; onChange: (next: string) => void; error?: string; disabled?: boolean }) {
  return <div><label htmlFor="bio">自己紹介（任意）</label><textarea id="bio" value={bio} readOnly={disabled} onChange={(e) => onChange(e.target.value)} aria-invalid={!!error} aria-describedby={`bio-count${error ? " bio-error" : ""}`} rows={5} className={inputClass} /><p id="bio-count" aria-live="polite" className="mt-2 text-right text-[13px] text-muted">{codePointLength(bio)} / 500文字</p>{error && <p id="bio-error" className="mt-2 text-sm">{error}</p>}</div>;
}
