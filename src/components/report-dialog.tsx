"use client";
import { useId, useRef, useState } from "react";
import { SafetyDialog, safetyButton } from "@/components/block-dialog";
import { useSafetyGateway } from "@/components/demo-safety-provider";
import { reportReasons, type ReportContext, type ReportReason } from "@/lib/safety-gateway";

export function ReportDialog({ target, context = "profile", message, onClose, returnFocus }: { target: string; context?: ReportContext; message?: { id: number; body: string }; onClose: () => void; returnFocus?: HTMLElement | null }) {
  const gateway = useSafetyGateway();
  const [reason, setReason] = useState<ReportReason>("harassment");
  const [detail, setDetail] = useState("");
  const [status, setStatus] = useState("");
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const fieldId = useId();
  return <SafetyDialog title="通報" onClose={onClose} returnFocus={returnFocus}>
    {message && <blockquote className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words rounded-xl bg-surface p-3 text-sm [overflow-wrap:anywhere]">{message.body}</blockquote>}
    <form autoComplete="off" onSubmit={async (e) => {
      e.preventDefault();
      if (inFlight.current || done || [...detail].length > 1000) return;
      inFlight.current = true; setBusy(true);
      try {
        const result = await gateway?.submitReport({ target, context, reason, detail, messageId: message?.id });
        setDone(result?.code === "ok");
        setStatus(result?.code === "ok" ? "通報を受け付けました（デモ）" : "この操作は利用できません。");
      } finally { inFlight.current = false; setBusy(false); }
    }}>
      <fieldset disabled={done} className="space-y-1"><legend className="mb-2 text-sm font-medium">通報の理由</legend>
        {Object.entries(reportReasons).map(([value, label]) => <label key={value} className="flex min-h-11 items-center gap-3 text-sm"><input type="radio" name={fieldId} value={value} checked={reason === value} onChange={() => setReason(value as ReportReason)} />{label}</label>)}
      </fieldset>
      <label htmlFor={fieldId} className="mt-4 block text-sm">詳細（任意）</label>
      <textarea id={fieldId} rows={3} disabled={done} value={detail} onChange={(e) => setDetail(e.target.value)} aria-describedby={`${fieldId}-count`} aria-invalid={[...detail].length > 1000} className="mt-2 w-full rounded-xl border border-line p-3" />
      <p id={`${fieldId}-count`} aria-live="polite" className="text-right text-xs">{[...detail].length} / 1000文字</p>
      <div className="mt-4 flex flex-col gap-3">
        {!done && <button type="submit" disabled={busy || [...detail].length > 1000} className={`${safetyButton} bg-ink text-white disabled:opacity-40`}>通報する（デモ）</button>}
        <button type="button" onClick={onClose} className={safetyButton}>{done ? "閉じる" : "キャンセル"}</button>
      </div>
      <p role="status" className="mt-3 text-sm">{status}</p>
    </form>
  </SafetyDialog>;
}
