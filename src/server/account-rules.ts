// Shared by the account settings client components and the server actions; holds no secrets or server state.
export const DELETE_CONFIRMATION = "退会する";
export type AccountState = "active" | "deactivated" | "suspended";
export type AccountActionStatus = "ok" | "invalid" | "invalid_state" | "forbidden" | "unauthenticated" | "unavailable";
// A paused account fails private.is_eligible, so pair_visible is false with everyone: it leaves
// discover/get_profile, incoming request lists and conversations, and cannot use them itself.
export const PAUSE_NOTE = "休止中は、探す・いいね・トークにあなたが表示されず、あなたも利用できません。";
export const actionMessages: Record<Exclude<AccountActionStatus, "ok">, string> = {
  invalid: "確認の言葉が一致しません。",
  invalid_state: "アカウントの状態が変わっています。ページを再読み込みしてください。",
  forbidden: "この操作は利用できません。",
  unauthenticated: "ログインし直してください。",
  unavailable: "現在保存できません。時間をおいて再度お試しください。",
};
