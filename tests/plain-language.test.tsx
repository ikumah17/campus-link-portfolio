// @vitest-environment node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// FIX-005: user screens on the web and in the app use plain words. Every Japanese string and JSX text of the
// user-facing sources (not /admin, whose staff read technical terms) is checked for jargon.
const JARGON = /UTF-?8|バイト|\bbytes?\b|JWT|RPC|トークン|\btokens?\b|\baal[12]?\b|ASCII|エンコード/i;
const JAPANESE = /[぀-ヿ一-鿿]/;
const ROOT = resolve(__dirname, "..");
const SOURCES = ["src/app", "src/components", "src/lib", "mobile/app", "mobile/src"];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (/admin/i.test(name)) return [];
    if (statSync(path).isDirectory()) return files(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

function userTexts(source: string) {
  // Comments are for developers; drop them before reading strings and JSX text.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  return [...code.matchAll(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`|>[^<>{}]+</g)]
    .map((match) => match[0]).filter((text) => JAPANESE.test(text));
}

describe("plain language on user screens (FIX-005)", () => {
  const all = SOURCES.flatMap((dir) => files(resolve(ROOT, dir)));

  it("reads the user-facing sources", () => {
    expect(all.length).toBeGreaterThan(50);
    const validation = all.find((path) => path.endsWith("auth-validation.ts"));
    expect(userTexts(readFileSync(validation!, "utf8")).some((text) => text.includes("半角の英字"))).toBe(true);
    expect(all.some((path) => path.replaceAll("\\", "/").endsWith("mobile/src/auth-screen.tsx"))).toBe(true);
  });

  it("has no jargon in any Japanese text", () => {
    const found = all.flatMap((path) => userTexts(readFileSync(path, "utf8"))
      .filter((text) => JARGON.test(text)).map((text) => `${relative(ROOT, path)}: ${text}`));
    expect(found).toEqual([]);
  });

  it("would catch the old password hint", () => {
    expect(userTexts('<p>8〜72文字、UTF-8で72バイト以内で入力してください。</p>').filter((text) => JARGON.test(text))).toHaveLength(1);
  });
});
