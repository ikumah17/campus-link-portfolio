import { render, screen, cleanup } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("@/components/main-nav", () => ({ MainNav: () => null }));
vi.mock("@/server/like-actions", () => ({ likeUser: vi.fn(), unlikeUser: vi.fn() }));
import { DiscoverLive, DiscoverNotEligible } from "@/components/discover-live";
const props = { conditions: { genders: [], schoolIds: [] }, schools: [], nextAfter: null };
const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
afterEach(() => { cleanup(); expect(fetchSpy).not.toHaveBeenCalled(); });
it("renders empty navigation without counts or demo words", () => {
  const { container } = render(<DiscoverLive {...props} profiles={[]} after="cursor" nextAfter="next" />);
  expect(screen.getByText("最初から見る")).toBeInTheDocument();
  expect(screen.getByText("次のプロフィールを見る").getAttribute("href")).toContain("after=next");
  expect(container.textContent).not.toMatch(/[0-9]|デモ|架空|モード|恋愛|申請/);
  expect(screen.queryByRole("navigation", { name: "モード" })).toBeNull();
});
it("offers verification when ineligible", () => { render(<DiscoverNotEligible />); expect(screen.getByText("確認へ進む")).toHaveAttribute("href", "/verification"); });
it("omits the restart link on the first empty page", () => { render(<DiscoverLive {...props} profiles={[]} />); expect(screen.queryByText("最初から見る")).toBeNull(); });

it("renders cards, chips and private media links", () => {
  render(<DiscoverLive {...props} conditions={{genders:["female"],schoolIds:["school"]}} schools={[{id:"school",name:"University"}]} profiles={[{id:"person",name:"Aoi",age:22,gender:"female",school:"University",department:null,class:null,bio:"Bio",purposes:["friends","study"],hobbies:["Books"],photoIds:["photo"]}]} />);
  expect(screen.getByAltText("Aoiの写真")).toHaveAttribute("src","/media/photos/photo");
  expect(screen.getByRole("link",{name:"Aoiのプロフィールを見る"})).toHaveAttribute("href","/profiles/person");
  expect(screen.getByRole("button",{name:"Aoiにいいね"})).toBeEnabled();
  expect(screen.getByText("友達がほしい・勉強仲間がほしい")).toBeInTheDocument();
  expect(screen.getByText("Bio")).toBeInTheDocument();
});
it("shows no result count with cards and no purposes line when there are none", () => {
  const { container } = render(<DiscoverLive {...props} nextAfter="next" profiles={[{id:"person",name:"Aoi",age:22,gender:"female",school:"University",department:null,class:null,bio:"Bio",purposes:[],hobbies:[],photoIds:[]}]} />);
  expect(container.textContent?.replace("22歳", "")).not.toMatch(/[0-9]|件数|件中|人中|ほしい/);
  expect(screen.getByRole("link", { name: "条件をクリア" })).toHaveAttribute("href", "/");
});
it("disables prefetch on profile and paging links", async () => {
  vi.resetModules();
  const seen: { href: string; prefetch?: boolean }[] = [];
  vi.doMock("next/link", () => ({ default: ({ href, prefetch, children }: { href: string; prefetch?: boolean; children: React.ReactNode }) => { seen.push({ href, prefetch }); return <a href={href}>{children}</a>; } }));
  const { DiscoverLive: Live } = await import("@/components/discover-live");
  render(<Live {...props} nextAfter="next" profiles={[{id:"person",name:"Aoi",age:22,gender:"female",school:"University",department:null,class:null,bio:"",purposes:[],hobbies:[],photoIds:[]}]} />);
  expect(seen.find(l => l.href.startsWith("/profiles/person"))?.prefetch).toBe(false);
  expect(seen.find(l => l.href.includes("after=next"))?.prefetch).toBe(false);
  vi.doUnmock("next/link");
});
