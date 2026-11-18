import { backendMode } from "@/lib/backend";

export const demoDisclaimer = "個人制作のデモです。麻生専門学校グループとは関係がなく、学校の公認を受けたものではありません。表示はすべて架空のデータです。";

// Shown above every page in demo mode only. Plain text, not a landmark and not focusable,
// so the skip link stays the first keyboard stop and each page keeps one main.
export function DemoDisclaimer() {
  if (backendMode() !== "demo") return null;
  return (
    <p className="border-b border-line bg-surface px-4 py-2 text-center text-xs leading-5 text-muted">
      {demoDisclaimer}
    </p>
  );
}
