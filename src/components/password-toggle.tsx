"use client";

import { textLink } from "@/components/ui-tokens";

// FIX-006: the password is hidden by default; this text button shows or hides it. Switching the input's type keeps
// its value, so the field is never cleared.
export function PasswordToggle({ shown, onToggle, controls }: { shown: boolean; onToggle: () => void; controls: string }) {
  return <div className="flex justify-end">
    <button type="button" className={textLink} aria-controls={controls} aria-label={shown ? "パスワードを隠す" : "パスワードを表示"} onClick={onToggle}>
      {shown ? "隠す" : "表示"}
    </button>
  </div>;
}
