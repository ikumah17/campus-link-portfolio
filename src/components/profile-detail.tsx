"use client";

import Link from "next/link";
import { useState } from "react";
import { BlockDialog } from "@/components/block-dialog";
import { ReportDialog } from "@/components/report-dialog";
import { MainNav } from "@/components/main-nav";
import { useDemoLikes } from "@/components/demo-likes-provider";
import { LikeControlsDemo } from "@/components/like-controls";
import { DEMO_NOTICE } from "@/lib/likes-demo";
import { purposeText } from "@/lib/onboarding-rules";
import { MAIN_CONTENT_ID } from "@/components/skip-link";
import type { DemoProfile } from "@/data/demo-profiles";
import { pageTitle, standalonePage, textLink } from "@/components/ui-tokens";

const NOTE_ID = "profile-detail-note";

const actionBase =
  "inline-flex min-h-11 w-full items-center justify-center rounded-full px-6 text-[15px] font-medium";

const circleButton =
  "inline-flex size-11 items-center justify-center rounded-full border border-line bg-white/75 text-ink-soft shadow-[0_2px_12px_rgba(0,0,0,0.04)] backdrop-blur-xl";

function BackIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m14.5 5-7 7 7 7" />
    </svg>
  );
}

function MoreIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="5.5" cy="12" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="18.5" cy="12" r="1.6" />
    </svg>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[5.5rem_1fr] gap-x-4 py-5 sm:grid-cols-[7rem_1fr]">
      <dt className="text-[15px] font-medium text-ink">{label}</dt>
      <dd className="m-0 text-[15px] leading-7 text-ink-soft">{children}</dd>
    </div>
  );
}

export function ProfileDetail({ profile }: { profile: DemoProfile }) {
  const { state } = useDemoLikes();
  const [blockOpen, setBlockOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  if (state.blocks?.some((b) => b.blocked_id === profile.id) && !blockOpen) return <main id={MAIN_CONTENT_ID} tabIndex={-1} className={standalonePage}><h1 className={pageTitle}>このプロフィールは表示できません</h1><Link className={`mt-6 ${textLink}`} href="/">一覧へ戻る</Link></main>;
  return (
    <div className="min-h-screen bg-white text-ink">
      <div inert={blockOpen || reportOpen}>
      <main id={MAIN_CONTENT_ID} tabIndex={-1} className="mx-auto w-full max-w-[1040px] px-4 pb-96 pt-6 sm:px-8 sm:pt-10">
        <div className="flex items-center justify-between">
          <Link href="/" aria-label="一覧へ戻る" className={`${circleButton} transition-colors hover:text-ink`}>
            <BackIcon />
          </Link>
          <button type="button" aria-disabled="true" aria-label="その他（準備中）" className={`${circleButton} cursor-not-allowed`}>
            <MoreIcon />
          </button>
        </div>

        <p className="mt-4 text-xs leading-6 text-muted">{DEMO_NOTICE}</p>
        <article aria-labelledby="profile-name" className="mt-5 grid grid-cols-1 gap-8 lg:grid-cols-2 lg:items-start lg:gap-12">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={profile.image}
            alt={profile.imageAlt}
            width={800}
            height={640}
            className="aspect-[5/4] w-full rounded-[28px] object-cover shadow-[0_8px_30px_rgba(0,0,0,0.06)]"
          />
          <div>
            <p className="text-xs text-muted">架空のデモプロフィール</p>
            <h1 id="profile-name" className="mt-2 flex items-baseline gap-3 text-[32px] font-medium leading-tight">
              {profile.name}
              <span className="text-2xl font-normal text-ink-soft">{profile.age}</span>
            </h1>
            <p className="mt-2 text-[15px] text-muted">
              {profile.gender}
              <span aria-hidden="true" className="mx-2 text-line">|</span>
              {profile.affiliation}
            </p>

            <dl className="mt-6 divide-y divide-line border-y border-line">
              {profile.bio && <Row label="自己紹介">{profile.bio}</Row>}
              {profile.hobbies.length > 0 && <Row label="趣味">
                <ul className="flex flex-wrap gap-2" aria-label="趣味">
                  {profile.hobbies.map((hobby) => (
                    <li key={hobby} className="rounded-full bg-surface px-4 py-1.5 text-sm text-ink-soft">
                      {hobby}
                    </li>
                  ))}
                </ul>
              </Row>}
              {profile.purposes.length > 0 && <Row label="目的">{purposeText(profile.purposes)}</Row>}
            </dl>
          </div>
        </article>
      </main>

      <div
        role="group"
        aria-label="プロフィールへの操作"
        className="fixed inset-x-0 bottom-24 z-10 border-t border-line bg-white/80 backdrop-blur-xl"
      >
        <div className="mx-auto flex w-full max-w-md flex-col gap-2 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 sm:max-w-xl">
          <LikeControlsDemo id={profile.id} name={profile.name} />
          <div className="flex flex-col gap-2 sm:flex-row">
            <button type="button" onClick={() => setBlockOpen(true)} className={`${actionBase} border border-line bg-white text-ink-soft`}>
              ブロック
            </button>
            <button type="button" onClick={() => setReportOpen(true)} className={`${actionBase} border border-line bg-white text-ink-soft`}>通報</button>
          </div>
          <p id={NOTE_ID} className="text-center text-xs text-muted">
            ブロック・通報は架空のデモです
          </p>
        </div>
      </div>
      <MainNav current="discover" />
      </div>
      {blockOpen && <BlockDialog target={profile.id} onClose={() => setBlockOpen(false)} />}
      {reportOpen && <ReportDialog target={profile.id} onClose={() => setReportOpen(false)} />}
    </div>
  );
}
