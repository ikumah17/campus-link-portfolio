import { expect, it } from "vitest";
import { reasonLabel, REJECTION_REASONS, REVOCATION_REASONS } from "@/lib/verification-reasons";
it("maps every reason without echoing untrusted input", () => {
  for (const code of [...Object.keys(REJECTION_REASONS), ...Object.keys(REVOCATION_REASONS), "affiliation_changed"]) { expect(reasonLabel(code)).not.toBe(code); expect(reasonLabel(code)).toMatch(/。$/); }
  for (const input of [undefined, null, 7, {}, "secret-provider-error", "__proto__", "toString"]) expect(reasonLabel(input)).toBe("確認できませんでした。");
});
