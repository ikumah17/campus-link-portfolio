"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useSafetyGateway } from "@/components/demo-safety-provider";
import { BlockDialog, safetyButton } from "@/components/block-dialog";
import { useDemoLikes } from "@/components/demo-likes-provider";
import { MainNav } from "@/components/main-nav";
import { MAIN_CONTENT_ID } from "@/components/skip-link";
import { SAFETY_NOTICE, type Block, type MyReport } from "@/lib/safety-gateway";
import { emptyState, noticeText, pageTitle, tabPage, textLink } from "@/components/ui-tokens";

const reportLabels = { open: "受付済み", triaged: "確認中", actioned: "対応済み", dismissed: "対応なし" };

export function BlocksSettings() {
  const gateway = useSafetyGateway();
  const { state } = useDemoLikes();
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [reports, setReports] = useState<MyReport[]>([]);
  const [target, setTarget] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void Promise.all([gateway?.listMyBlocks(), gateway?.myReports()]).then(([b, r]) => {
      if (active) { setBlocks(b?.data ?? []); setReports(r?.data ?? []); }
    });
    return () => { active = false; };
  }, [gateway, state, target]);
  return <div className="min-h-screen bg-white text-ink">
    <div inert={target !== null}><main id={MAIN_CONTENT_ID} tabIndex={-1} className={tabPage}>
      <Link href={"/mypage"} className={textLink}>マイページへ戻る</Link>
      <h1 className={`mt-4 ${pageTitle}`}>ブロック中のユーザー</h1>
      <p className={noticeText}>{SAFETY_NOTICE}</p>
      {blocks.length === 0 ? <p className={`mt-6 ${emptyState}`}>ブロック中のユーザーはいません。</p> : <ul className="mt-6 divide-y divide-line">{blocks.map((b) => <li key={b.blocked_id} className="flex flex-wrap items-center justify-between gap-3 py-4">
        <div><p>{b.blocked_name_snapshot ?? "表示できないユーザー"}</p><time className="text-xs text-muted" dateTime={new Date(b.created_at).toISOString()}>{new Date(b.created_at).toISOString().slice(0, 10)}</time></div>
        <button type="button" className={safetyButton} onClick={() => setTarget(b.blocked_id)}>ブロック解除</button>
      </li>)}</ul>}
      <section className="mt-10"><h2 className="text-lg font-medium">通報の履歴</h2>
        {reports.length === 0 ? <p className={`mt-3 ${emptyState}`}>通報の履歴はありません。</p> : <ul className="mt-3 space-y-3">{reports.map((r) => <li key={r.id} className="break-words text-sm"><span>{r.id}</span> · <time dateTime={new Date(r.created_at).toISOString()}>{new Date(r.created_at).toISOString().slice(0, 16).replace("T", " ")}</time> · <span>{reportLabels[r.status]}</span></li>)}</ul>}
      </section>
    </main><MainNav current="mypage" /></div>
    {target !== null && <BlockDialog target={target} unblock onClose={() => setTarget(null)} />}
  </div>;
}
