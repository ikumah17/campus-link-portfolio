import { expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/backend", () => ({ backendMode: () => "supabase" }));
vi.mock("@/lib/supabase/server", () => ({ createServerSupabase: vi.fn() }));
vi.mock("@/components/profile-detail-live", () => ({ ProfileDetailLive: () => null }));
vi.mock("@/components/profile-detail", () => ({ ProfileDetail: () => null }));
import { dynamic, generateMetadata, generateStaticParams } from "@/app/profiles/[id]/page";

it("keeps unknown hosted profile IDs request-rendered, with generic metadata", async () => {
  // Regression: [] alone opts unknown IDs into static ISR; production requests
  // then fail with DYNAMIC_SERVER_USAGE when cookies/connection are accessed.
  expect(generateStaticParams()).toEqual([]);
  expect(dynamic).toBe("force-dynamic");
  expect(await generateMetadata({ params: Promise.resolve({ id: "12345678-1234-4123-8123-123456789abc" }), searchParams: Promise.resolve({}) })).toEqual({ title: "プロフィール | Campus Link" });
});
