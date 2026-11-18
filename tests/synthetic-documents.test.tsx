// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { syntheticDocument } from "@/server/synthetic-documents";

let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => { fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network forbidden")); });
afterEach(() => { expect(fetchSpy).not.toHaveBeenCalled(); vi.restoreAllMocks(); });

it.each([1, 2, 3])("returns only fictional sample %i in an inert, self-contained SVG", (n) => {
  const svg = syntheticDocument(`synthetic:sample-${n}`)!;
  expect(svg).toContain(`架空のサンプル資料 ${n}`);
  expect(svg).toContain("実在の人物・学校とは関係ありません");
  for (const other of [1, 2, 3].filter((value) => value !== n)) {
    expect(svg).not.toContain(`架空のサンプル資料 ${other}`);
  }
  // Coordinator clarification msg_096ffd2437aa: the root namespace is an identifier.
  const namespace = 'xmlns="http://www.w3.org/2000/svg"';
  expect(svg.split(namespace)).toHaveLength(2);
  expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" /);
  expect(svg.replace(namespace, "")).not.toMatch(/<script|\bon\w*\s*=|href|foreignObject|http/i);
  expect(svg).not.toMatch(/<!|<\?|<image|<use|<style|url\s*\(/i);
});

it.each(["synthetic:sample-4", "synthetic:sample-1 ", "synthetic:sample-1\n", "synthetic:sample-1\r",
  "synthetic:sample-1\u2028", "sample-1", "../sample-1", "SYNTHETIC:sample-1", "synthetic:sample-01",
  '<script>alert(1)</script>', null, undefined, 1, {}, ["synthetic:sample-1"]])("rejects any nonexact reference %#", (reference) => {
  expect(syntheticDocument(reference)).toBeNull();
});
