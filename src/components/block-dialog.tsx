"use client";
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useSafetyGateway } from "@/components/demo-safety-provider";
import { SAFETY_NOTICE } from "@/lib/safety-gateway";

export const safetyButton = "min-h-11 min-w-11 rounded-full border border-line px-5 py-2 text-sm";
export function SafetyDialog({ title, onClose, children, returnFocus }: { title: string; onClose: () => void; children: ReactNode; returnFocus?: HTMLElement | null }) {
  const titleId = useId(), noticeId = useId();
  const panel = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const trigger = returnFocus ?? document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLElement>("button, input, textarea")?.focus();
    return () => queueMicrotask(() => {
      // Switching from the action menu to a confirmation must keep focus in the new dialog.
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      if (trigger?.isConnected && !trigger.closest("[inert]")) trigger.focus();
      else document.getElementById("main-content")?.focus();
    });
  }, []);
  useLayoutEffect(() => {
    if (!panel.current?.contains(document.activeElement)) panel.current?.querySelector<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled)')?.focus();
  });
  return <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 p-4">
    <div ref={panel} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={noticeId} className="max-h-[90dvh] w-full max-w-md overflow-y-auto rounded-[28px] bg-white p-6 text-ink shadow-xl" onKeyDown={(e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); }
      if (e.key === "Tab") {
        const controls = [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), textarea:not(:disabled), input:not(:disabled)') ?? [])]
          .filter((el) => !(el instanceof HTMLInputElement && el.type === "radio" && !el.checked));
        const first = controls[0], last = controls.at(-1);
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    }}>
      <h2 id={titleId} className="text-xl font-medium">{title}</h2>
      <p id={noticeId} className="mt-3 text-xs leading-6 text-muted">{SAFETY_NOTICE}</p>
      <div className="mt-5 space-y-4">{children}</div>
    </div>
  </div>;
}
export function BlockDialog({ target, unblock = false, onClose, returnFocus }: { target: string; unblock?: boolean; onClose: () => void; returnFocus?: HTMLElement | null }) {
  const gateway = useSafetyGateway();
  const [status, setStatus] = useState("");
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  return <SafetyDialog title={unblock ? "ブロックを解除しますか" : "ブロックしますか"} onClose={onClose} returnFocus={returnFocus}>
    <p className="text-sm leading-7">{unblock ? "ブロックを解除しても、消えたいいねや終了したつながりは元に戻りません。" : "お互いに表示されなくなり、いいねとつながりは終了します。相手に通知は届きません。"}</p>
    <div className="flex flex-col gap-3">
      {!done && <button type="button" className={`${safetyButton} bg-ink text-white`} disabled={busy} onClick={async () => {
        if (inFlight.current) return;
        inFlight.current = true; setBusy(true);
        try {
          const result = await (unblock ? gateway?.unblockUser(target) : gateway?.blockUser(target));
          setDone(result?.code === "ok");
          setStatus(result?.code === "ok" ? (unblock ? "ブロックを解除しました（デモ）" : "ブロックしました（デモ）") : "この操作は利用できません。");
        } finally { inFlight.current = false; setBusy(false); }
      }}>{unblock ? "ブロック解除" : "ブロックする"}</button>}
      <button type="button" className={safetyButton} onClick={onClose}>{done ? "閉じる" : "キャンセル"}</button>
    </div>
    <p role="status" className="text-sm">{status}</p>
  </SafetyDialog>;
}
