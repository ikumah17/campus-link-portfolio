"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { usePrivacyGateway } from "@/components/demo-privacy-provider";
import { MAIN_CONTENT_ID } from "@/components/skip-link";
import {
  DEMO_HIDE_TARGETS,
  TARGET_FIELDS,
  HIDE_TARGET_KIND_LABEL,
  defaultPrivacySettings,
  samePrivacySettings,
  type HideTargetKind,
  type PrivacyFlag,
  type PrivacySettings as Settings,
} from "@/data/demo-privacy";

const DEMO_NOTICE = "デモ：設定はこの画面を開いている間だけ保持され、実際の表示制限には反映されません。";

const SECTIONS: { id: string; title: string; description: string; rows: { flag: PrivacyFlag; title: string; description: string }[] }[] = [
  {
    id: "privacy-hide",
    title: "身バレ防止設定",
    description: "特定のつながりのあるユーザーに表示しない設定です。",
    rows: [
      { flag: "hideSameClass", title: "同じクラスに表示しない", description: "同じクラスのユーザーにプロフィールを表示しません。" },
      { flag: "hideSameDepartment", title: "同じ学科に表示しない", description: "同じ学科のユーザーにプロフィールを表示しません。" },
      { flag: "hideSameSchool", title: "同じ学校に表示しない", description: "同じ学校のユーザーにプロフィールを表示しません。" },
    ],
  },
  {
    id: "privacy-academic",
    title: "学業情報の公開設定",
    description: "プロフィールに表示する学業情報を選びます。",
    rows: [
      { flag: "showDepartment", title: "学科名を公開", description: "プロフィールに学科名を表示します。" },
      { flag: "showClass", title: "クラス名を公開", description: "プロフィールにクラス名を表示します。" },
    ],
  },
];

const TARGET_KINDS: HideTargetKind[] = ["school", "department", "class"];

const circleButton =
  "inline-flex size-11 items-center justify-center rounded-full border border-line bg-white/75 text-ink-soft shadow-[0_2px_12px_rgba(0,0,0,0.04)] backdrop-blur-xl";

function BackIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m14.5 5-7 7 7 7" />
    </svg>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={`shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
    >
      <path d="m9.5 5 7 7-7 7" />
    </svg>
  );
}

function SwitchRow({ id, title, description, checked, onChange }: { id: string; title: string; description: string; checked: boolean; onChange: (next: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-4 py-4">
      <div className="min-w-0">
        <p id={`${id}-label`} className="text-[16px] text-ink">
          {title}
        </p>
        <p id={`${id}-desc`} className="mt-1 text-[13px] leading-5 text-muted">
          {description}
        </p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-desc`}
        onClick={() => onChange(!checked)}
        className="inline-flex h-11 w-[60px] shrink-0 cursor-pointer items-center justify-center rounded-full"
      >
        <span
          aria-hidden="true"
          className={`relative h-[31px] w-[51px] rounded-full transition-colors ${checked ? "bg-ink" : "bg-[#e9e9eb] ring-1 ring-inset ring-[#8a8a8e]"}`}
        >
          <span
            className={`absolute left-[2px] top-[2px] size-[27px] rounded-full bg-white shadow-[0_2px_6px_rgba(0,0,0,0.2)] transition-transform ${checked ? "translate-x-5" : ""}`}
          />
        </span>
      </button>
    </div>
  );
}

function SectionHeader({ id, title, description }: { id: string; title: string; description: string }) {
  return (
    <div className="px-4 pb-3 pt-4">
      <h2 id={id} className="text-[17px] font-medium text-ink">
        {title}
      </h2>
      <p className="mt-1 text-[13px] leading-5 text-muted">{description}</p>
    </div>
  );
}

type SaveStatus = "idle" | "ok" | "validation" | "rate_limited";

export function PrivacySettings() {
  const gateway = usePrivacyGateway();
  const revision = useRef(0);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<Settings>(defaultPrivacySettings);
  const [saved, setSaved] = useState<Settings>(defaultPrivacySettings);
  const [load, setLoad] = useState(false);
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [panelOpen, setPanelOpen] = useState(false);

  useEffect(() => {
    let active = true;
    setLoad(false);
    void gateway.getMySettings().then((result) => {
      if (!active) return;
      if (result.code === "ok") { setDraft(result.data); setSaved(result.data); }
      else setStatus(result.code);
      setLoad(true);
    });
    return () => { active = false; };
  }, [gateway]);

  function update(next: Settings) {
    revision.current += 1;
    setDraft(next);
    // A previous success message must not describe values that have since changed.
    setStatus("idle");
  }

  function toggleTarget(id: string, kind: HideTargetKind) {
    const field = TARGET_FIELDS[kind];
    const ids = draft[field];
    update({ ...draft, [field]: ids.includes(id) ? ids.filter((t) => t !== id) : [...ids, id] });
  }

  async function save() {
    const savedRevision = revision.current;
    setSaving(true);
    const result = await gateway.updatePrivacySettings(draft);
    if (result.code === "ok") setSaved(result.data);
    if (revision.current === savedRevision) setStatus(result.code);
    setSaving(false);
  }

  const dirty = !samePrivacySettings(draft, saved);
  const count = Object.values(TARGET_FIELDS).reduce((total, field) => total + draft[field].length, 0);

  return (
    <div className="min-h-screen bg-white text-ink">
      <main id={MAIN_CONTENT_ID} tabIndex={-1} className="mx-auto w-full max-w-2xl px-4 pb-64 pt-6 sm:px-8 sm:pt-10">
        <div className="grid grid-cols-[44px_1fr_44px] items-center gap-2">
          <Link href={"/mypage"} aria-label="マイページへ戻る" className={`${circleButton} transition-colors hover:text-ink`}>
            <BackIcon />
          </Link>
          <h1 className="text-center text-[19px] font-medium">公開範囲設定</h1>
        </div>

        <p className="mt-8 text-[24px] font-medium leading-snug">プロフィールを表示する相手を制限する設定のデモです。</p>
        <p className="mt-3 text-[15px] leading-7 text-muted">特定のクラス・学科・学校のユーザーに表示しない設定を試せます。</p>
        <p role="note" className="mt-4 rounded-[18px] border border-line px-4 py-3 text-[13px] leading-6 text-ink-soft">
          {DEMO_NOTICE}
        </p>

        <div className="mt-8 flex flex-col gap-6">
          {SECTIONS.map((section) => (
            <section key={section.id} aria-labelledby={section.id} className="rounded-[24px] bg-surface p-1.5">
              <SectionHeader id={section.id} title={section.title} description={section.description} />
              <div className="divide-y divide-line rounded-[18px] bg-white px-4">
                {section.rows.map((row) => (
                  <SwitchRow
                    key={row.flag}
                    id={`switch-${row.flag}`}
                    title={row.title}
                    description={row.description}
                    checked={draft[row.flag]}
                    onChange={(next) => update({ ...draft, [row.flag]: next })}
                  />
                ))}
              </div>
            </section>
          ))}

          <section aria-labelledby="privacy-targets" className="rounded-[24px] bg-surface p-1.5">
            <SectionHeader id="privacy-targets" title="非表示対象の個別指定" description="学校・学科・クラスを個別に指定して、表示しないようにします。" />
            <div className="rounded-[18px] bg-white">
              <button
                type="button"
                aria-expanded={panelOpen}
                aria-controls="privacy-targets-panel"
                onClick={() => setPanelOpen((open) => !open)}
                className="flex min-h-14 w-full cursor-pointer items-center justify-between gap-4 rounded-[18px] px-4 text-left text-[16px] text-ink"
              >
                <span>非表示対象を管理</span>
                <span className="flex items-center gap-2 text-[13px] text-muted">
                  {count}件指定中
                  <ChevronIcon open={panelOpen} />
                </span>
              </button>
              <div id="privacy-targets-panel" hidden={!panelOpen} className="border-t border-line px-4 pb-2 pt-3">
                <p className="text-[13px] leading-5 text-muted">候補はすべて架空です。実在の学校・学科・クラスではありません。</p>
                {TARGET_KINDS.map((kind) => (
                  <div key={kind} className="mt-3">
                    <h3 className="text-[13px] font-medium text-ink-soft">{HIDE_TARGET_KIND_LABEL[kind]}</h3>
                    <ul className="divide-y divide-line">
                      {DEMO_HIDE_TARGETS.filter((t) => t.kind === kind).map((target) => {
                        const selected = draft[TARGET_FIELDS[kind]].includes(target.id);
                        return (
                          <li key={target.id} className="flex items-center justify-between gap-3 py-2">
                            <span className="min-w-0 text-[15px] text-ink">
                              {target.label}
                              {selected && <span className="ml-2 text-[13px] text-muted">指定中</span>}
                            </span>
                            <button
                              type="button"
                              aria-label={`${target.label}を${selected ? "解除" : "追加"}`}
                              onClick={() => toggleTarget(target.id, kind)}
                              className={`inline-flex min-h-11 min-w-[72px] shrink-0 cursor-pointer items-center justify-center rounded-full px-4 text-[14px] font-medium transition-colors ${
                                selected ? "bg-surface text-ink-soft hover:text-ink" : "border border-line bg-white text-ink hover:border-ink-soft"
                              }`}
                            >
                              {selected ? "解除" : "追加"}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ))}
              </div>
            </div>
          </section>
        </div>
      </main>

      <div role="group" aria-label="デモ設定の保存" className="fixed inset-x-0 bottom-0 z-10 border-t border-line bg-white/80 backdrop-blur-xl">
        <div className="mx-auto flex w-full max-w-md flex-col gap-2 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 sm:max-w-xl">
          {/* Live regions stay mounted (empty when idle) so screen readers announce changes. */}
          <div className="text-center text-[13px] leading-5">
            <p role="status" className="text-ink-soft">
              {status === "ok" ? "デモ設定を保存しました。" : status === "idle" && dirty ? "未保存の変更があります。" : ""}
            </p>
            <p role="alert" className="font-medium text-ink">
              {status === "rate_limited" ? "しばらくしてから再度お試しください" : status === "validation" ? "設定内容を確認してください。保存できませんでした。" : ""}
            </p>
          </div>
          <button
            type="button"
            onClick={save}
            disabled={!load || saving}
            aria-describedby="privacy-save-note"
            className="inline-flex min-h-12 w-full cursor-pointer items-center justify-center rounded-full bg-ink px-6 text-[16px] font-medium text-white transition-colors hover:bg-ink-soft disabled:cursor-wait disabled:bg-ink-soft"
          >
            デモ設定を保存
          </button>
          <p id="privacy-save-note" className="text-center text-xs text-muted">
            この画面を開いている間のみ・実際の表示制限には反映されません
          </p>
        </div>
      </div>
    </div>
  );
}
