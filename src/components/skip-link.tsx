// Every page renders exactly one <main id={MAIN_CONTENT_ID} tabIndex={-1}> so the browser moves focus into it.
export const MAIN_CONTENT_ID = "main-content";

// A plain fragment link keeps the current path and query. It waits above the viewport at full 44px size
// (still in the accessibility tree) and appears instantly, without a transition, only while focused.
export function SkipLink() {
  return (
    <a
      href={`#${MAIN_CONTENT_ID}`}
      className="fixed left-4 top-4 z-50 inline-flex min-h-11 translate-y-[-200%] items-center rounded-full bg-ink px-5 text-[15px] font-medium text-white shadow-[0_8px_30px_rgba(0,0,0,0.12)] focus:translate-y-0"
    >
      本文へスキップ
    </a>
  );
}
