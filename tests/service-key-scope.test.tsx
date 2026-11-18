// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const SERVICE_KEY_MODULES = ["src/server/auth-rate.ts", "src/server/storage/document-read.ts", "src/server/storage/photo-ingest.ts", "src/server/storage/photo-read.ts"];
let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => { fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network forbidden")); });
afterEach(() => { expect(fetchSpy).not.toHaveBeenCalled(); vi.restoreAllMocks(); });
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? sources(path) : [path];
  });
}

it("confines the service key to the reviewed server-only modules and forbids delivery URLs", () => {
  const readers: string[] = [];
  for (const path of sources("src")) {
    const name = relative(process.cwd(), path).replaceAll("\\", "/");
    const source = readFileSync(path, "utf8");
    if (source.includes("SUPABASE_SERVICE_ROLE_KEY")) {
      readers.push(name);
      expect(SERVICE_KEY_MODULES).toContain(name);
      expect(source).toContain('import "server-only"');
    }
    expect(source, name).not.toMatch(/createSignedUrls?|getPublicUrl/);
  }
  expect(readers).toEqual(SERVICE_KEY_MODULES);
});
