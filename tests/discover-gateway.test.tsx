import { describe, expect, it } from "vitest";
import { demoAffiliations } from "@/data/demo-affiliations";
import { demoProfiles } from "@/data/demo-profiles";
import { createDemoLikes, demoViewer } from "@/data/demo-likes";
import { conditionLabels, conditionsFromSearch, createDiscoverDemo, normalizeConditions, searchHref, type DiscoverParams } from "@/lib/discover-gateway";
import type { LikesState } from "@/lib/likes-demo";
const empty = { genders: [], schoolIds: [] };
const params: DiscoverParams = { ...empty };
const state = (): LikesState => ({ now: 100, likes: [], connections: [] });

describe("Discover normalization", () => {
  it.each([[17, undefined], [18, 18], [120, 120], [121, undefined], [18.5, undefined], ["20x", undefined], ["", undefined]])("normalizes boundary %s", (value, expected) => {
    expect(normalizeConditions({ min: value }).min).toBe(expected);
    expect(normalizeConditions({ max: value }).max).toBe(expected);
  });
  it("drops reversed ranges, repeated scalars and unknown identifiers", () => {
    expect(conditionsFromSearch("min=25&max=20&g=unknown&s=unknown")).toEqual({ ...empty, min: undefined, max: undefined });
    expect(conditionsFromSearch("min=18&min=19&max=bad").min).toBeUndefined();
    expect(conditionsFromSearch("g=female&g=female&g=other").genders).toEqual(["female", "other"]);
  });
  it("round trips known filters with no extra query fields, and never writes a mode", () => {
    const conditions = { min: 18, max: 120, genders: ["female", "male"] as const, schoolIds: [demoAffiliations[0].id] };
    const input = { ...conditions, genders: [...conditions.genders] };
    const href = searchHref("/", input);
    expect(href).not.toContain("mode");
    expect(conditionsFromSearch(href.split("?")[1])).toEqual(input);
    expect(conditionLabels(input)).toEqual(["18〜120歳", "女性", "男性", demoAffiliations[0].name]);
  });
});
describe("in-memory Discover gateway", () => {
  it("filters ages, genders and schools individually and together", async () => {
    const gateway = createDiscoverDemo(state, demoViewer);
    for (const [filters, ids] of [
      [{ min: 20 }, ["demo-1", "demo-2"]], [{ max: 20 }, ["demo-1", "demo-3"]],
      [{ genders: ["male"] }, ["demo-2"]], [{ schoolIds: [demoAffiliations[1].id] }, ["demo-2", "demo-3"]],
      [{ min: 19, max: 20, genders: ["female"], schoolIds: [demoAffiliations[1].id] }, ["demo-3"]],
    ] as const) {
      const result = await gateway.discoverProfiles({ ...params, ...filters } as DiscoverParams);
      expect(result.data.map((p) => p.id)).toEqual(ids);
      expect(Object.keys(result)).toEqual(["code", "data"]);
      expect(JSON.stringify(result)).not.toMatch(/count|total/i);
    }
  });
  it("excludes self, matches, people the viewer liked and blocks; keeps people who liked the viewer", async () => {
    const current = createDemoLikes();
    const gateway = createDiscoverDemo(() => current, demoViewer);
    expect((await gateway.discoverProfiles(params)).data.map((p) => p.id)).toEqual(["demo-1", "demo-2", "demo-3"]);
    current.connections.push(["demo-1", demoViewer]);
    current.likes.push({ liker: demoViewer, liked: "demo-3", createdAt: current.now });
    expect((await gateway.discoverProfiles(params)).data.map((p) => p.id)).toEqual(["demo-2"]);
    current.blocks = [{ blocked_id: "demo-2", blocked_name_snapshot: null, created_at: current.now }];
    expect((await gateway.discoverProfiles(params)).data).toEqual([]);
    expect((await createDiscoverDemo(state, "demo-1").discoverProfiles(params)).data.map((p) => p.id)).toEqual(["demo-2", "demo-3"]);
  });
  it("pages by id after filtering and clamps limits to 1–50", async () => {
    const profiles = Array.from({ length: 60 }, (_, i) => ({ ...demoProfiles[0], id: `profile-${String(i).padStart(3, "0")}` })).reverse();
    const gateway = createDiscoverDemo(state, demoViewer, profiles);
    expect((await gateway.discoverProfiles({ ...params, limit: 0 })).data.map((p) => p.id)).toEqual(["profile-000"]);
    expect((await gateway.discoverProfiles({ ...params, limit: 100 })).data).toHaveLength(50);
    expect((await gateway.discoverProfiles({ ...params, after: "profile-049", limit: 2 })).data.map((p) => p.id)).toEqual(["profile-050", "profile-051"]);
    expect((await gateway.discoverProfiles({ ...params, limit: NaN })).data).toHaveLength(20);
  });
});
it("accepts an injected active school master", () => {
  const schools = [{ id: "live-school", name: "大学" }];
  const c = conditionsFromSearch("s=live-school&s=unknown", schools);
  expect(c.schoolIds).toEqual(["live-school"]);
  expect(conditionLabels(c, schools)).toEqual(["大学"]);
  expect(searchHref("/", c, schools)).toContain("s=live-school");
});
