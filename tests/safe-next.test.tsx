// @vitest-environment node
import { describe, expect, it } from "vitest";
import { safeNextPath } from "@/lib/safe-next";

describe("safeNextPath", () => {
  it.each(["/", "/talk?x=1", "/a#b", "/" + "a".repeat(511)])("accepts %s", (path) => expect(safeNextPath(path)).toBe(path));
  it.each(["//evil.example", "/\\evil", "/%2F%2Fevil", "/%5Cevil", "https://x", "javascript:alert(1)", "/has space", "/has\ttab", "%E0%A4%A", "/%E0%A4%A", "/%00", "/%20", "/%7f", "/" + "a".repeat(512), null, 3, ""])("rejects %#", (path) => expect(safeNextPath(path)).toBeUndefined());
});
