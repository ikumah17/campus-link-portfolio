"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { MainNav } from "@/components/main-nav";
import { MAIN_CONTENT_ID } from "@/components/skip-link";
import { demoAffiliations } from "@/data/demo-affiliations";
import { conditionsFromSearch, genders, normalizeAge, searchHref, type SearchConditions } from "@/lib/discover-gateway";
import { pageTitle, primaryButton, secondaryButton, tabPage, textLink } from "@/components/ui-tokens";

const control = "min-h-11 rounded-xl border border-line px-4";
const empty: SearchConditions = { genders: [], schoolIds: [] };
export function SearchConditionsForm({ initialConditions = empty, schools = demoAffiliations }: { initialConditions?: SearchConditions; schools?: readonly { id: string; name: string }[] }) {
  const router = useRouter();
  const [conditions, setConditions] = useState(initialConditions);
  const [min, setMin] = useState(initialConditions.min?.toString() ?? "");
  const [max, setMax] = useState(initialConditions.max?.toString() ?? "");
  const [errors, setErrors] = useState<{ min?: string; max?: string }>({});
  const minRef = useRef<HTMLInputElement>(null), maxRef = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    const current = conditionsFromSearch(window.location.search, schools);
    setConditions(current);
    setMin(current.min?.toString() ?? ""); setMax(current.max?.toString() ?? "");
  }, [schools]);
  function submit(event: FormEvent) {
    event.preventDefault();
    const next: typeof errors = {};
    if (min !== "" && normalizeAge(min) === undefined) next.min = "18〜120の整数を入力してください。";
    if (max !== "" && normalizeAge(max) === undefined) next.max = "18〜120の整数を入力してください。";
    if (!next.min && !next.max && min !== "" && max !== "" && Number(min) > Number(max)) next.min = "下限は上限以下にしてください。";
    setErrors(next);
    if (next.min || next.max) { (next.min ? minRef : maxRef).current?.focus(); return; }
    router.push(searchHref("/", { ...conditions, min: normalizeAge(min), max: normalizeAge(max) }, schools));
  }
  function clear() {
    setMin(""); setMax(""); setConditions(empty); setErrors({});
    window.history.replaceState(null, "", searchHref("/search", empty, schools));
    minRef.current?.focus();
  }
  return <div className="min-h-screen bg-white text-ink">
    <main id={MAIN_CONTENT_ID} tabIndex={-1} className={tabPage}>
      <Link href={searchHref("/", conditions, schools)} className={textLink}>一覧へ戻る</Link>
      <h1 className={`mt-4 ${pageTitle}`}>検索条件</h1>
      <form noValidate onSubmit={submit} className="mt-8 space-y-8">
        <fieldset><legend className="mb-4 font-medium">年齢</legend>
          <div className="grid grid-cols-2 gap-4">
            <div><label htmlFor="age-min" className="mb-2 block text-sm">下限年齢</label>
              <input ref={minRef} id="age-min" type="number" min="18" max="120" step="1" value={min} onChange={(e) => setMin(e.target.value)} aria-invalid={!!errors.min} aria-describedby={errors.min ? "min-error" : undefined} className={`${control} w-full`} />
              {errors.min && <p id="min-error" role="alert" className="mt-2 text-sm">{errors.min}</p>}
            </div>
            <div><label htmlFor="age-max" className="mb-2 block text-sm">上限年齢</label>
              <input ref={maxRef} id="age-max" type="number" min="18" max="120" step="1" value={max} onChange={(e) => setMax(e.target.value)} aria-invalid={!!errors.max} aria-describedby={errors.max ? "max-error" : undefined} className={`${control} w-full`} />
              {errors.max && <p id="max-error" role="alert" className="mt-2 text-sm">{errors.max}</p>}
            </div>
          </div>
        </fieldset>
        <fieldset><legend className="mb-3 font-medium">性別</legend><div className="flex flex-wrap gap-3">
          {genders.map((g) => <label key={g.id} className={`${control} inline-flex cursor-pointer items-center gap-3`}>
            <input type="checkbox" className="size-5 accent-ink" checked={conditions.genders.includes(g.id)} onChange={(e) => setConditions({ ...conditions, genders: e.target.checked ? [...conditions.genders, g.id] : conditions.genders.filter((v) => v !== g.id) })} />{g.label}
          </label>)}
        </div></fieldset>
        <fieldset><legend className="mb-3 font-medium">学校</legend><div className="flex flex-col gap-3">
          {schools.map((s) => <label key={s.id} className={`${control} inline-flex cursor-pointer items-center gap-3`}>
            <input type="checkbox" className="size-5 shrink-0 accent-ink" checked={conditions.schoolIds.includes(s.id)} onChange={(e) => setConditions({ ...conditions, schoolIds: e.target.checked ? [...conditions.schoolIds, s.id] : conditions.schoolIds.filter((v) => v !== s.id) })} />{s.name}
          </label>)}
        </div></fieldset>
        <p className="text-sm leading-7 text-muted">学科・クラスでの絞り込みはプライバシー保護のため提供していません。</p>
        <div className="flex flex-col gap-3">
          <button type="submit" className={primaryButton}>この条件で探す</button>
          <button type="button" onClick={clear} className={secondaryButton}>条件をクリア</button>
        </div>
      </form>
    </main><MainNav current="discover" />
  </div>;
}
