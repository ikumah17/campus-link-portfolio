/// <reference types="node" />
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// docs/42 §1.1: the web files the app shares must not import next, react-dom or server-only (or anything else).
describe("shared web files", () => {
  const shared = readFileSync(resolve(__dirname, "../src/shared.ts"), "utf8");
  const files = [...shared.matchAll(/from "(\.\.\/\.\.\/src\/lib\/[^"]+)"/g)].map((match) => match[1]);

  it("are only files of src/lib", () => {
    expect(files.length).toBeGreaterThan(0);
    expect(shared.match(/from "/g)?.length).toBe(files.length);
  });

  it.each([...new Set(files)])("%s imports nothing", (file) => {
    const source = readFileSync(resolve(__dirname, "../src", `${file}.ts`), "utf8");
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/\brequire\(|\bimport\(/);
    expect(source).not.toMatch(/^\s*export\s[^;]*\sfrom\s/m);
  });
});
