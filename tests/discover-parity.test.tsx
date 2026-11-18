// @vitest-environment node
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createMasters, createUser, connect, type UserSpec } from "./db/fixtures";
import { freshDb, asUser, user, owner } from "./db/harness";
vi.mock("server-only", () => ({}));
import { listProfiles, getProfile } from "@/server/discover-data";
let db: PGlite;
const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
beforeAll(async () => { db = await freshDb(); }, 180000);
afterAll(async () => { expect(fetchSpy).not.toHaveBeenCalled(); await db?.close(); vi.restoreAllMocks(); });
function client(me: string) { return { async rpc(name: string, args: Record<string, unknown>) {
  const keys = Object.keys(args);
  const casts: Record<string, string> = { p_genders: 'text[]', p_school_ids: 'uuid[]', p_after: 'uuid', p_target: 'uuid' };
  try { return { data: await asUser(db, user(me), `select * from public.${name}(${keys.map((k,i) => `${k} => $${i+1}${casts[k] ? `::${casts[k]}` : ''}`).join(',')})`, Object.values(args)), error: null }; }
  catch (e) { throw e; }
} }; }
it("list/detail/photo parity through real authenticated RPCs", async () => {
  const masters = await createMasters(db, "live");
  const a = masters.classes[0], b = masters.classes[4];
  const cases: { label: string; viewer?: UserSpec; target?: UserSpec; block?: boolean; reverse?: boolean; connected?: boolean; liked?: boolean; likedMe?: boolean }[] = [
    {label:'visible'}, {label:'block',block:true}, {label:'reverse block',block:true,reverse:true},
    {label:'viewer hidden',viewer:{hidden:{schools:[b.schoolId]}}}, {label:'target hidden',target:{hidden:{schools:[a.schoolId]}}},
    {label:'unconfirmed',target:{affiliation:'unconfirmed'}}, {label:'expired',target:{affiliation:'expired'}}, {label:'age',target:{ageVerified:false}}, {label:'suspended',target:{status:'suspended'}}, {label:'viewer ineligible',viewer:{ageVerified:false}}, {label:'different purposes',viewer:{purposes:['friends']},target:{purposes:['partner','talk']}}, {label:'connected',connected:true}, {label:'liked',liked:true}, {label:'liked me',likedMe:true},
  ];
  for (const c of cases) {
    const me = await createUser(db,{cls:a,...c.viewer}); const target = await createUser(db,{cls:b,...c.target});
    if(c.block) await owner(db,'insert into public.blocks (blocker_id,blocked_id) values ($1,$2)',c.reverse?[target,me]:[me,target]);
    if(c.connected) await connect(db,me,target);
    if(c.liked) await owner(db,"insert into public.likes (liker_id,liked_id) values ($1,$2)",[me,target]);
    if(c.likedMe) await owner(db,"insert into public.likes (liker_id,liked_id) values ($1,$2)",[target,me]);
    const list = await listProfiles(client(me),{genders:[],schoolIds:[]});
    const detail = await getProfile(client(me),target);
    expect(list.status,c.label).toBe('ok'); expect(detail.status,c.label).toBe('ok');
    if(list.status !== 'ok' || detail.status !== 'ok') throw new Error(c.label);
    const visible = ['visible', 'different purposes', 'liked me'].includes(c.label) || c.connected || c.liked;
    expect(!!detail.profile,c.label).toBe(!!visible);
    const listed = list.profiles.find(p=>p.id===target);
    expect(!!listed,c.label).toBe(['visible', 'different purposes', 'liked me'].includes(c.label));
    // Connections and the viewer's own likes are excluded from Discover only; one mode, so purposes never hide anyone.
    if(listed) { expect(listed).toEqual(detail.profile); expect(listed.department).toBeNull(); expect(listed.class).toBeNull(); }
    if(c.label === 'different purposes') expect(detail.profile?.purposes).toEqual(['partner','talk']);
    const [photo] = await owner<{id:string}>(db,'select id from public.profile_photos where user_id=$1',[target]);
    const authorized = await asUser(db,user(me),'select * from public.authorize_photo_delivery($1::uuid[])',[[photo.id]]);
    expect(authorized.length,c.label).toBe(visible?1:0);
  }
},120000);


it("pages without gaps or duplicate profiles", async () => {
  const m = await createMasters(db,'paging');
  const me = await createUser(db,{cls:m.classes[0]});
  const expected: string[]=[];
  for(let i=0;i<23;i++) expected.push(await createUser(db,{cls:m.classes[4]}));
  const ids: string[]=[]; let after: string|undefined;
  do {
    const page = await listProfiles(client(me),{genders:[],schoolIds:[m.schools[1]],after});
    expect(page.status).toBe('ok'); if(page.status!=='ok') throw new Error('page');
    ids.push(...page.profiles.map(p=>p.id)); after=page.nextAfter??undefined;
  } while(after);
  expect(ids).toEqual(expected.sort()); expect(new Set(ids).size).toBe(ids.length);
},120000);
