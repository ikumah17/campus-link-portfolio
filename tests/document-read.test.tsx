// @vitest-environment node
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ create: vi.fn(), from: vi.fn(), download: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@supabase/supabase-js", () => ({ createClient: mocks.create }));
vi.mock("@/lib/supabase/config", () => ({ supabasePublicConfig: () => ({ url: "https://synthetic.supabase.co" }) }));
import { readDocument } from "@/server/storage/document-read";
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const path = `${id}/document_1/submission-2.webp`;
const secret = "sb_secret_fake";
const bytes = new TextEncoder().encode("synthetic webp").buffer;
let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", secret);
  fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network forbidden"));
  mocks.create.mockReturnValue({ storage: { from: mocks.from } }); mocks.from.mockReturnValue({ download: mocks.download });
  mocks.download.mockResolvedValue({ data: { arrayBuffer: async () => bytes }, error: null });
});
afterEach(() => { expect(fetchSpy).not.toHaveBeenCalled(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("E-2 read-only storage boundary", () => {
  it.each(["../other", `${id}/../document.webp`, "not-a-uuid/doc.webp", path.replaceAll("/", "\\"),
    "synthetic:sample-1", `${id}/${"a".repeat(64)}/${"b".repeat(64)}/${"c".repeat(64)}/dddddddddddddddddddd.webp`,
    path.toUpperCase(), `${path}\n`, `${path}\r`, `${path}\u2028`, `${path}?download=1`, `${path}#fragment`,
    path.replace(".webp", ".png"), `${id}//doc.webp`, `${id}/${"a".repeat(65)}.webp`, `${id}/.webp`,
    `${id}/%2e%2e/doc.webp`, `verification-documents/${path}`, null, undefined, {}])("rejects an invalid reference %# before any client or download", async (reference) => {
    expect(await readDocument(reference)).toBeNull();
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.download).not.toHaveBeenCalled();
  });
  it.each([secret, `e30.${Buffer.from(JSON.stringify({ role: "service_role" })).toString("base64url")}.c2ln`])("reads only the constant bucket through a private nonpersistent service client %#", async (key) => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", key);
    expect(await readDocument(path)).toEqual(bytes);
    expect(mocks.create).toHaveBeenCalledExactlyOnceWith("https://synthetic.supabase.co", key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    expect(mocks.from).toHaveBeenCalledExactlyOnceWith("verification-documents");
    expect(mocks.download).toHaveBeenCalledExactlyOnceWith(path);
  });
  it("accepts the full 256-character boundary and rejects the next character", async () => {
    const boundary = `${id}/${"a".repeat(64)}/${"b".repeat(64)}/${"c".repeat(64)}/${"d".repeat(19)}.webp`;
    expect(boundary).toHaveLength(256);
    expect(await readDocument(boundary)).toEqual(bytes);
    mocks.create.mockClear(); mocks.download.mockClear();
    expect(await readDocument(boundary.replace(".webp", "x.webp"))).toBeNull();
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.download).not.toHaveBeenCalled();
  });
  it.each([undefined, "", "sb_publishable_fake", `${secret}\n`, ` ${secret}`, "e30.bm90anNvbg.c2ln",
    `e30.${Buffer.from(JSON.stringify({ role: "anon" })).toString("base64url")}.c2ln`])("refuses non-service keys %#", async (key) => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", key);
    expect(await readDocument(path)).toBeNull(); expect(mocks.create).not.toHaveBeenCalled();
  });
  it.each(["error", "missing", "throw", "bytes", "client"])("returns null without logging on %s failure", async (failure) => {
    const log = vi.spyOn(console, "error"); const warn = vi.spyOn(console, "warn");
    if (failure === "error") mocks.download.mockResolvedValue({ data: null, error: { message: "private" } });
    if (failure === "missing") mocks.download.mockResolvedValue({ data: null, error: null });
    if (failure === "throw") mocks.download.mockRejectedValue(new Error("private"));
    if (failure === "bytes") mocks.download.mockResolvedValue({ data: { arrayBuffer: async () => { throw new Error("private"); } }, error: null });
    if (failure === "client") mocks.create.mockImplementation(() => { throw new Error("private"); });
    expect(await readDocument(path)).toBeNull(); expect(log).not.toHaveBeenCalled(); expect(warn).not.toHaveBeenCalled();
  });
  it("keeps E-2 separate from E-1/E-3 with no signing or mutation capability", () => {
    const source = readFileSync("src/server/storage/document-read.ts", "utf8");
    expect(source).toContain('import "server-only"');
    expect(source).not.toMatch(/createSignedUrls?|getPublicUrl|\.(?:upload|remove|update|upsert|delete|move|copy)\s*\(|photo-ingest|photo-read/);
    expect(source).not.toMatch(/export\s+(?:const|function)\s+(?:serviceClient|key)/);
    expect(source.match(/process\.env\.SUPABASE_SERVICE_ROLE_KEY/g)).toHaveLength(1);
    for (const name of ["photo-ingest", "photo-read"]) {
      expect(readFileSync(`src/server/storage/${name}.ts`, "utf8")).not.toContain("document-read");
    }
  });
});
