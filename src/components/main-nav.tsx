import Link from "next/link";

type NavIconName = "search" | "like" | "talk" | "me";

export type MainNavPage = "discover" | "mypage" | "likes" | "talk";

const NAV_ITEMS: { icon: NavIconName; label: string; page?: MainNavPage; path?: string }[] = [
  { icon: "search", label: "探す", page: "discover", path: "/" },
  { icon: "like", label: "いいね", page: "likes", path: "/likes" },
  { icon: "talk", label: "トーク", page: "talk", path: "/talk" },
  { icon: "me", label: "マイページ", page: "mypage", path: "/mypage" },
];

function NavIcon({ name }: { name: NavIconName }) {
  const common = {
    width: 24,
    height: 24,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.6,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  switch (name) {
    case "search":
      return (
        <svg {...common}>
          <circle cx="11" cy="11" r="6.5" />
          <path d="m16 16 4 4" />
        </svg>
      );
    case "like":
      return (
        <svg {...common}>
          <path d="M12 20s-7.5-4.6-7.5-10A4.2 4.2 0 0 1 12 7.6 4.2 4.2 0 0 1 19.5 10c0 5.4-7.5 10-7.5 10Z" />
        </svg>
      );
    case "talk":
      return (
        <svg {...common}>
          <path d="M4.5 6.5a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H10l-4 3v-3h-.5a1 1 0 0 1-1-1Z" />
        </svg>
      );
    case "me":
      return (
        <svg {...common}>
          <circle cx="12" cy="8.5" r="3.5" />
          <path d="M5 20a7 7 0 0 1 14 0" />
        </svg>
      );
  }
}

const itemBase = "flex min-h-14 w-full flex-col items-center justify-center gap-0.5 rounded-[22px] px-1 text-[11px]";

export function MainNav({ current }: { current: MainNavPage }) {
  return (
    <nav
      aria-label="メインナビゲーション"
      className="fixed inset-x-0 bottom-0 z-10 mx-auto mb-4 w-[calc(100%-2rem)] max-w-md rounded-[28px] border border-line bg-white/75 p-1.5 shadow-[0_8px_30px_rgba(0,0,0,0.08)] backdrop-blur-xl"
    >
      <ul className="grid grid-cols-4">
        {NAV_ITEMS.map((item) => {
          const isCurrent = item.page === current;
          return (
            <li key={item.label}>
              {item.path ? (
                <Link
                  href={item.path}
                  aria-current={isCurrent ? "page" : undefined}
                  className={`${itemBase} transition-colors ${isCurrent ? "bg-black/5 font-medium text-ink" : "text-ink-soft hover:text-ink"}`}
                >
                  <NavIcon name={item.icon} />
                  <span>{item.label}</span>
                </Link>
              ) : (
                <button type="button" aria-disabled="true" className={`${itemBase} cursor-not-allowed text-muted`}>
                  <NavIcon name={item.icon} />
                  <span>{item.label}</span>
                  <span className="sr-only">（準備中）</span>
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
