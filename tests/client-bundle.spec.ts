import { expect, test } from "@playwright/test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}

test("NT-23: production browser artifacts contain no service-role capability", () => {
  // Playwright's existing webServer builds the production app before this runs.
  const artifacts = files(join(process.cwd(), ".next/static"));
  expect(artifacts.length).toBeGreaterThan(0);
  const capabilityPattern = /SUPABASE_SERVICE_ROLE_KEY|sb_secret_[A-Za-z0-9_-]{8,}|service_role/;
  expect(capabilityPattern.test("sb_secret_" + "a".repeat(20))).toBe(true);
  expect(capabilityPattern.test("'sb_secret_'")).toBe(false);
  expect(capabilityPattern.test("sb_secret_…")).toBe(false);
  const findings = artifacts.filter((path) => capabilityPattern.test(readFileSync(path).toString("utf8")))
    .map((path) => relative(process.cwd(), path));
  // Report only file names, never matched contents.
  expect(findings).toEqual([]);
});
