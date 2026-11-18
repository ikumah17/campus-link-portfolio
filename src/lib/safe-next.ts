/** A relative, same-origin destination, checked both before and after decoding. */
export function safeNextPath(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.length > 512) return undefined;
  const safe = (value: string) => value.startsWith("/") && !value.startsWith("//") && !/[\\\u0000-\u0020\u007f]/.test(value);
  if (!safe(raw)) return undefined;
  try {
    if (!safe(decodeURIComponent(raw))) return undefined;
  } catch {
    return undefined;
  }
  return raw;
}
