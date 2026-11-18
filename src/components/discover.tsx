"use client";

import Link from "next/link";
import { useEffect, useLayoutEffect, useState } from "react";
import { MainNav } from "@/components/main-nav";
import { useDiscoverGateway } from "@/components/demo-discover-provider";
import { conditionLabels, conditionsFromSearch, searchHref, type SearchConditions } from "@/lib/discover-gateway";
import { MAIN_CONTENT_ID } from "@/components/skip-link";
import type { DemoProfile } from "@/data/demo-profiles";
import { LikeControlsDemo } from "@/components/like-controls";
import { purposeText } from "@/lib/onboarding-rules";
import { emptyState, loadingText, primaryButton } from "@/components/ui-tokens";

function FilterIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
      <path d="M4 7h10M18 7h2M4 17h2M10 17h10" />
      <circle cx="16" cy="7" r="2" />
      <circle cx="8" cy="17" r="2" />
    </svg>
  );
}

function ProfileCard({ profile }: { profile: DemoProfile }) {
  return (
    <article
      aria-labelledby={`${profile.id}-name`}
      className="flex flex-col overflow-hidden rounded-[28px] border border-line bg-white shadow-[0_8px_30px_rgba(0,0,0,0.06)]"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={profile.image} alt={profile.imageAlt} width={800} height={640} className="aspect-[5/4] w-full object-cover" />
      <div className="flex flex-1 flex-col gap-4 p-6">
        <div>
          <h2 id={`${profile.id}-name`} className="flex items-baseline gap-3 text-[26px] font-medium leading-tight">
            {profile.name}
            <span className="text-xl font-normal text-ink-soft">{profile.age}</span>
          </h2>
          <p className="mt-2 text-[15px] text-muted">
            {profile.gender}
            <span aria-hidden="true" className="mx-2 text-line">|</span>
            {profile.affiliation}
          </p>
        </div>
        {profile.purposes.length > 0 && <p className="text-[13px] text-muted">{purposeText(profile.purposes)}</p>}
        <p className="text-[15px] leading-7 text-ink-soft">{profile.bio}</p>
        <ul className="flex flex-wrap gap-2" aria-label="趣味">
          {profile.hobbies.map((hobby) => (
            <li key={hobby} className="rounded-full bg-surface px-4 py-2 text-sm text-ink-soft">
              {hobby}
            </li>
          ))}
        </ul>
        <div className="mt-auto flex flex-col gap-3 pt-2">
          <Link
            href={`/profiles/${profile.id}`}
            aria-label={`${profile.name}のプロフィールを見る`}
            className={`${primaryButton} transition-colors hover:bg-ink-soft`}
          >
            プロフィールを見る
          </Link>
          <LikeControlsDemo id={profile.id} name={profile.name} />
        </div>
      </div>
    </article>
  );
}

export function Discover() {
  const gateway = useDiscoverGateway();
  const [conditions, setConditions] = useState<SearchConditions>({ genders: [], schoolIds: [] });
  const [profiles, setProfiles] = useState<DemoProfile[] | null>(null);

  // Browser back can restore a cached render of "/" made for other conditions; the URL is the source of truth.
  useLayoutEffect(() => {
    setConditions(conditionsFromSearch(window.location.search));
  }, []);

  useEffect(() => {
    let active = true;
    gateway.discoverProfiles(conditions).then((result) => { if (active) setProfiles(result.data); });
    return () => { active = false; };
  }, [gateway, conditions]);

  function clearConditions() {
    const empty = { genders: [], schoolIds: [] };
    setConditions(empty);
    window.history.replaceState(null, "", searchHref("/", empty));
  }
  const labels = conditionLabels(conditions);

  return (
    <div className="min-h-screen bg-white text-ink">
      <main id={MAIN_CONTENT_ID} tabIndex={-1} className="mx-auto w-full max-w-[1200px] px-4 pb-40 pt-6 sm:px-8 sm:pt-10">
        <header className="flex items-start justify-between gap-4">
          <h1 className="font-brand text-[34px] leading-none tracking-tight sm:text-[40px]">Campus Link</h1>
          <Link href={searchHref("/search", conditions)} className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-full border border-line px-3 text-sm text-ink-soft">
            <FilterIcon /><span>検索条件</span>
          </Link>
        </header>

        <p className="mt-4 text-center text-xs text-muted">表示中のプロフィールはすべて架空のデモデータです</p>

        {labels.length > 0 && <div className="mt-5 flex flex-wrap items-center gap-2" aria-label="適用中の検索条件">
          {labels.map((label) => <span key={label} className="rounded-full bg-surface px-4 py-2 text-sm">{label}</span>)}
          <button type="button" onClick={clearConditions} className="min-h-11 rounded-full border border-line px-4 text-sm">条件をクリア</button>
        </div>}
        {profiles === null && <p role="status" className={`mt-8 text-center ${loadingText}`}>読み込み中</p>}
        {profiles?.length === 0 && <p role="status" className={`mt-8 text-center ${emptyState}`}>条件に合うプロフィールはありません</p>}
        <section aria-label="プロフィール一覧" className="mt-6 grid grid-cols-1 gap-6 md:grid-cols-[repeat(auto-fit,minmax(18rem,21rem))] md:justify-center xl:grid-cols-[repeat(auto-fit,minmax(18rem,23.5rem))]">
          {profiles?.map((profile) => (
            <ProfileCard key={profile.id} profile={profile} />
          ))}
        </section>
      </main>

      <MainNav current="discover" />
    </div>
  );
}
