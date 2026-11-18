import { SafetyControlsLive } from "@/components/safety-controls-live";
import { LikeControlsLive } from "@/components/like-controls-live";
import { NO_LIKE } from "@/components/like-controls";
import Link from "next/link";
import { MainNav } from "@/components/main-nav";
import { MAIN_CONTENT_ID } from "@/components/skip-link";
import { genders } from "@/lib/discover-gateway";
import { purposeText } from "@/lib/onboarding-rules";
import type { LiveProfile } from "@/server/discover-data";
import type { LikeState } from "@/server/like-data";
import { textLink } from "@/components/ui-tokens";
// likeState: get_like_state; null when it could not be read (the buttons then start from "いいね" and the database decides).
export function ProfileDetailLive({ profile: p, likeState }: { profile: LiveProfile; likeState: LikeState | null }) {
  const rows = ([["自己紹介", p.bio], ["趣味", p.hobbies.join(" / ")], ["目的", purposeText(p.purposes)]] as const).filter(([, value]) => value);
  return <div className="min-h-screen bg-white text-ink"><main id={MAIN_CONTENT_ID} tabIndex={-1} className="mx-auto w-full max-w-[1040px] px-4 pb-48 pt-6 sm:px-8 sm:pt-10">
    <Link href="/" className={textLink}>一覧へ戻る</Link><article className="mt-8 grid gap-8 lg:grid-cols-2"><div className="space-y-4">{p.photoIds.map((id, i) =>
      /* eslint-disable-next-line @next/next/no-img-element */
      <img key={id} src={`/media/photos/${id}`} alt={`${p.name}の写真 ${i + 1}`} width={800} height={640} loading="lazy" className="aspect-[5/4] w-full rounded-[28px] object-cover" />)}</div><div><h1 className="flex items-baseline gap-3 text-[32px] font-medium leading-tight">{p.name} <span className="text-xl font-normal text-ink-soft">{p.age}歳</span></h1><p className="mt-2 text-[15px] text-muted">{genders.find(g => g.id === p.gender)?.label}</p><p className="text-[15px] text-muted">{[p.school, p.department, p.class].filter(v => v !== null).join(" / ")}</p>{rows.length > 0 && <dl className="mt-6 divide-y divide-line border-y border-line">{rows.map(([label, value]) => <div key={label} className="grid grid-cols-[7rem_1fr] gap-4 py-5"><dt>{label}</dt><dd className="whitespace-pre-wrap break-words">{value}</dd></div>)}</dl>}</div></article>
    <div className="mt-8 max-w-md"><LikeControlsLive id={p.id} name={p.name} initial={likeState ?? NO_LIKE} /></div>
    <div className="mt-4 flex flex-wrap items-center gap-3"><SafetyControlsLive kind="profile" id={p.id} name={p.name} block /></div>
  </main><MainNav current="discover" /></div>;
}
