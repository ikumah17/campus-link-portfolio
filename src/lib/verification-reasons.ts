export const REJECTION_REASONS = {
  document_unreadable: "資料を読み取れませんでした。",
  document_mismatch: "資料と登録内容が一致しませんでした。",
  not_eligible: "確認の条件を満たしていません。",
  other: "確認できませんでした。",
} as const;
export const REVOCATION_REASONS = {
  no_longer_enrolled: "在学を確認できなくなりました。",
  document_invalid: "資料の内容を確認できなくなりました。",
  other: "確認を取り消しました。",
} as const;
export function reasonLabel(code: unknown): string {
  if (code === "affiliation_changed") return "所属を変更したため、提出は無効になりました。";
  if (typeof code !== "string") return REJECTION_REASONS.other;
  if (Object.hasOwn(REJECTION_REASONS, code)) return REJECTION_REASONS[code as keyof typeof REJECTION_REASONS];
  if (Object.hasOwn(REVOCATION_REASONS, code)) return REVOCATION_REASONS[code as keyof typeof REVOCATION_REASONS];
  return REJECTION_REASONS.other;
}
