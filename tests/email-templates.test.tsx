import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// MAIL-001: the auth email templates link only through the app's /auth/confirm route.
const templates = [
  { file: "confirm-signup.html", type: "signup" },
  { file: "magic-link.html", type: "email" },
] as const;

const read = (file: string) => readFileSync(`supabase/templates/${file}`, "utf8");

describe.each(templates)("$file", ({ file, type }) => {
  const html = read(file);

  it(`links to /auth/confirm with token_hash and type=${type}`, () => {
    expect(html).toContain(`{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=${type}"`);
    const types = [...html.matchAll(/&type=([a-z_]+)/g)].map((match) => match[1]);
    expect(types.length).toBeGreaterThan(0);
    expect(new Set(types)).toEqual(new Set([type]));
  });

  it("never uses ConfirmationURL", () => {
    expect(html).not.toMatch(/ConfirmationURL/);
  });

  it("has no external URL other than SiteURL", () => {
    expect(html).not.toMatch(/(?:https?:)?\/\/[a-z0-9]/i);
    for (const match of html.matchAll(/\b(?:href|src)\s*=\s*"([^"]*)"/gi)) {
      expect(match[1].startsWith("{{ .SiteURL }}/")).toBe(true);
    }
    expect(html).not.toMatch(/url\(/i);
  });

  it("has no script", () => {
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/javascript:/i);
  });

  it("gives a subject line in the top comment", () => {
    expect(html).toMatch(/^<!-- Subject: \S.*-->/);
  });
});
