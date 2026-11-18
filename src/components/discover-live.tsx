import Link from "next/link";
import { MainNav } from "@/components/main-nav";
import { MAIN_CONTENT_ID } from "@/components/skip-link";
import { LikeControlsLive } from "@/components/like-controls-live";
import { purposeText } from "@/lib/onboarding-rules";
import { conditionLabels, genders, searchHref, type Schools, type SearchConditions } from "@/lib/discover-gateway";
import type { LiveProfile } from "@/server/discover-data";
import { emptyState, primaryButton, secondaryButton, standalonePage, textLink } from "@/components/ui-tokens";
export function DiscoverNotEligible() {
  return <main id={MAIN_CONTENT_ID} tabIndex={-1} className={standalonePage}><h1 className="font-brand text-[28px]">Campus Link</h1><p className="my-8 leading-7">在学・年齢確認が終わると、プロフィールを探せます。</p><Link href="/verification" className={primaryButton}>確認へ進む</Link></main>;
}
export function DiscoverLive({ profiles, conditions, schools, after, nextAfter }: { profiles: LiveProfile[]; conditions: SearchConditions; schools: Schools; after?: string; nextAfter: string | null }) {
  const base = searchHref("/", conditions, schools);
  return <div className="min-h-screen bg-white text-ink"><main id={MAIN_CONTENT_ID} tabIndex={-1} className="mx-auto w-full max-w-[1200px] px-4 pb-40 pt-6 sm:px-8 sm:pt-10">
    <header className="flex items-start justify-between gap-4"><h1 className="font-brand text-[34px] leading-none tracking-tight sm:text-[40px]">Campus Link</h1><Link href={searchHref("/search", conditions, schools)} className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-full border border-line px-4 text-sm text-ink-soft">検索条件</Link></header>
    <div className="mt-5 flex flex-wrap items-center gap-2">{conditionLabels(conditions, schools).map(label => <span className="rounded-full bg-surface px-4 py-2 text-sm" key={label}>{label}</span>)}<Link href="/" className="inline-flex min-h-11 items-center rounded-full border border-line px-4 text-sm">条件をクリア</Link></div>
    <div className="mt-6 grid grid-cols-1 gap-6 md:grid-cols-[repeat(auto-fit,minmax(18rem,21rem))] md:justify-center xl:grid-cols-[repeat(auto-fit,minmax(18rem,23.5rem))]">{profiles.map(p => <article key={p.id} className="flex flex-col overflow-hidden rounded-[28px] border border-line bg-white shadow-[0_8px_30px_rgba(0,0,0,0.06)]">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {p.photoIds[0] ? <img src={`/media/photos/${p.photoIds[0]}`} alt={`${p.name}の写真`} width={800} height={640} loading="lazy" className="aspect-[5/4] w-full object-cover" /> : <div className="aspect-[5/4] w-full bg-surface" />}
      <div className="flex flex-1 flex-col gap-4 p-6"><h2 className="flex items-baseline gap-3 text-[26px] font-medium leading-tight">{p.name} <span className="text-xl font-normal text-ink-soft">{p.age}歳</span></h2><p className="text-[15px] text-muted">{genders.find(g => g.id === p.gender)?.label}</p><p className="text-[15px] text-muted">{[p.school, p.department, p.class].filter(v => v !== null).join(" / ")}</p>{p.purposes.length > 0 && <p className="text-[13px] text-muted">{purposeText(p.purposes)}</p>}<p className="text-[15px] leading-7 text-ink-soft">{p.bio}</p><ul className="flex flex-wrap gap-2">{p.hobbies.map(h => <li key={h} className="rounded-full bg-surface px-4 py-2 text-sm text-ink-soft">{h}</li>)}</ul><div className="mt-auto flex flex-col gap-3 pt-2"><Link prefetch={false} aria-label={`${p.name}のプロフィールを見る`} href={`/profiles/${p.id}`} className={primaryButton}>プロフィールを見る</Link><LikeControlsLive id={p.id} name={p.name} /></div></div>
    </article>)}</div>
    {!profiles.length && <div className={`mt-8 text-center ${emptyState}`}><p>条件に合うプロフィールはありません</p>{after && <Link href={base} className={`${textLink} text-ink`}>最初から見る</Link>}</div>}
    {nextAfter && <Link prefetch={false} className={`mt-8 ${secondaryButton}`} href={`${base}${base.includes("?") ? "&" : "?"}after=${nextAfter}`}>次のプロフィールを見る</Link>}
  </main><MainNav current="discover" /></div>;
}
