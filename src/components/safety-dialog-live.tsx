"use client";
import { useId, useLayoutEffect, useRef, type ReactNode } from "react";



export const liveSafetyButton = "min-h-11 min-w-11 rounded-full border border-line px-5 py-2 text-sm";
export function LiveSafetyDialog({ title, onClose, children, returnFocus }: { title: string; onClose: () => void; children: ReactNode; returnFocus?: HTMLElement | null }) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const trigger = returnFocus ?? document.activeElement as HTMLElement | null;
    // Inert every sibling branch up to body while keeping the modal branch active.
    const background: {element: HTMLElement; inert: boolean}[] = [];
    let branch: HTMLElement | null = panel.current?.parentElement ?? null;
    while (branch && branch !== document.body) {
      for (const sibling of branch.parentElement?.children ?? []) {
        if (sibling !== branch && sibling instanceof HTMLElement && !sibling.hasAttribute("inert")) {
          background.push({element: sibling, inert: sibling.inert});
          sibling.inert = true;
        }
      }
      branch = branch.parentElement;
    }
    (panel.current?.querySelector<HTMLElement>("button:not(:disabled), input:not(:disabled), textarea:not(:disabled)") ?? panel.current)?.focus();
    return () => {
      for (const {element, inert} of background) element.inert = inert;
      queueMicrotask(() => {
      // Switching from the action menu to a confirmation must keep focus in the new dialog.
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      if (trigger?.isConnected && !trigger.closest("[inert]")) trigger.focus();
      else document.getElementById("main-content")?.focus();
      });
    };
  }, []);
  useLayoutEffect(() => {
    if (!panel.current?.contains(document.activeElement) || document.activeElement?.matches(":disabled")) {
      (panel.current?.querySelector<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled)') ?? panel.current)?.focus();
    }
  });
  return <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 p-4">
    <div ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={titleId} className="max-h-[90dvh] w-full max-w-md overflow-y-auto rounded-[28px] bg-white p-6 text-ink shadow-xl" onKeyDown={(e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); }
      if (e.key === "Tab") {
        const controls = [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), textarea:not(:disabled), input:not(:disabled), a[href]') ?? [])]
          .filter((el) => !(el instanceof HTMLInputElement && el.type === "radio" && !el.checked));
        const first = controls[0], last = controls.at(-1);
        if (!first) { e.preventDefault(); panel.current?.focus(); }
        else if (document.activeElement === panel.current) { e.preventDefault(); (e.shiftKey ? last : first)?.focus(); }
        else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    }}>
      <h2 id={titleId} className="text-xl font-medium">{title}</h2>

      <div className="mt-5 space-y-4">{children}</div>
    </div>
  </div>;
}
