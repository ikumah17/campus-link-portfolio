// MOD-001: what a participant sees in place of a message or request message a moderator took out of view.
// It never names who hid it. The text is fixed in the app; the hidden body itself never reaches the browser.
export const HIDDEN_CONTENT_TEXT = "この発言は運営により非表示になりました。";
export function HiddenContentNotice({ className = "" }: { className?: string }) {
  return <p className={`text-sm leading-6 text-muted ${className}`}>{HIDDEN_CONTENT_TEXT}</p>;
}
