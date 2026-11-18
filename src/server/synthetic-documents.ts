import "server-only";

export function syntheticDocument(reference: unknown): string | null {
  if (typeof reference !== "string") return null;
  const match = /^synthetic:sample-([1-3])$/.exec(reference);
  if (!match || match[0] !== reference) return null;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="440" viewBox="0 0 720 440"><rect width="720" height="440" fill="white"/><rect x="24" y="24" width="672" height="392" rx="12" fill="white" stroke="#d4d4d4"/><text x="60" y="200" fill="black" font-family="sans-serif" font-size="28">架空のサンプル資料 ${match[1]}</text><text x="60" y="250" fill="#666666" font-family="sans-serif" font-size="20">実在の人物・学校とは関係ありません</text></svg>`;
}
