vi.mock("@/lib/supabase/browser",()=>({createBrowserSupabase:()=>{throw Error("test fallback");}}));
vi.mock("@/server/safety-actions",()=>({blockProfile:vi.fn(),blockConversation:vi.fn(),unblockUser:vi.fn(),reportProfile:vi.fn(),reportConversation:vi.fn(),reportMessage:vi.fn()}));
﻿import {it,expect,vi,afterEach,beforeEach} from "vitest";
import {render,screen,fireEvent,waitFor,act} from "@testing-library/react";
const m=vi.hoisted(()=>({send:vi.fn(),latest:vi.fn(),older:vi.fn(),read:vi.fn()}));
vi.mock("@/server/chat-actions",()=>({sendChatMessage:m.send,latestMessages:m.latest,olderMessages:m.older,markRead:m.read}));
import {ChatRoomLive} from "@/components/chat-room-live";
const conversation={id:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",partner:{name:"Partner",photoId:null},latest:null,unread:false};
const message=(id:number,mine=false)=>({id,mine,body:`body ${id}`,createdAt:"2026-01-01T12:34:00Z",hidden:false});
const network=vi.spyOn(globalThis,"fetch").mockRejectedValue(Error("network"));
beforeEach(()=>{vi.clearAllMocks();m.read.mockResolvedValue({status:"ok"});m.latest.mockResolvedValue({status:"ok",messages:[message(2)],hasOlder:false});});afterEach(()=>expect(network).not.toHaveBeenCalled());
function view(messages=[message(1)],hasOlder=false){return render(<ChatRoomLive conversation={conversation} messages={messages} hasOlder={hasOlder}/>)}
it("accessible log, only other's newest is marked and no demo notice",()=>{const r=view();expect(screen.getByRole("log")).toHaveTextContent("Partner：body 1");expect(m.read).toHaveBeenCalledWith(conversation.id,1);expect(r.container.innerHTML).not.toMatch(/架空|デモ|sender_id/);expect(screen.getByRole("button",{name:"ブロック・通報"})).toBeEnabled();});
it("does not mark own newest",()=>{view([message(1,true)]);expect(m.read).not.toHaveBeenCalled();});
it("retry preserves client token and merging deduplicates",async()=>{m.send.mockResolvedValueOnce({status:"unavailable"}).mockResolvedValue({status:"ok",messages:[message(1),message(2,true)]});view();fireEvent.change(screen.getByLabelText("メッセージ"),{target:{value:"hello"}});fireEvent.click(screen.getByRole("button",{name:"送信"}));await screen.findByText("メッセージを送信できません。");fireEvent.click(screen.getByRole("button",{name:"送信"}));await screen.findByText("メッセージを送信しました。");expect(m.send.mock.calls[0]).toEqual(m.send.mock.calls[1]);expect(screen.getAllByText("body 1")).toHaveLength(1);expect(screen.getByLabelText("メッセージ")).toHaveValue("");});
it("pages older and reloads from all three triggers, removing listeners",async()=>{m.older.mockResolvedValue({status:"ok",messages:[message(1)],hasOlder:false});const v=view([message(2)],true);fireEvent.click(screen.getByRole("button",{name:"以前のメッセージ"}));await screen.findByText("body 1");expect(m.older).toHaveBeenCalledWith(conversation.id,2);fireEvent.click(screen.getByRole("button",{name:"新しいメッセージを確認"}));await waitFor(()=>expect(m.latest).toHaveBeenCalledTimes(1));await act(async()=>{window.dispatchEvent(new Event("focus"));});expect(m.latest).toHaveBeenCalledTimes(2);await act(async()=>{document.dispatchEvent(new Event("visibilitychange"));});expect(m.latest).toHaveBeenCalledTimes(3);v.unmount();window.dispatchEvent(new Event("focus"));document.dispatchEvent(new Event("visibilitychange"));expect(m.latest).toHaveBeenCalledTimes(3);});
it("switches to uniform missing view",async()=>{m.latest.mockResolvedValue({status:"not_available"});view();fireEvent.click(screen.getByRole("button",{name:"新しいメッセージを確認"}));await screen.findByText("この会話は表示できません");expect(screen.queryByText("Partner")).not.toBeInTheDocument();});
it("guards simultaneous sends and ignores composing shortcut",async()=>{let finish!:(v:unknown)=>void;m.send.mockReturnValue(new Promise(r=>{finish=r}));view();const input=screen.getByLabelText("メッセージ");fireEvent.change(input,{target:{value:"hello"}});fireEvent.keyDown(input,{key:"Enter",ctrlKey:true,isComposing:true});expect(m.send).not.toHaveBeenCalled();fireEvent.keyDown(input,{key:"Enter",ctrlKey:true});fireEvent.keyDown(input,{key:"Enter",ctrlKey:true});expect(m.send).toHaveBeenCalledTimes(1);await act(async()=>finish({status:"ok",messages:[],hasOlder:false}));});
it("a changed retry body gets a new id and rate limit is fixed text",async()=>{m.send.mockResolvedValueOnce({status:"unavailable"}).mockResolvedValue({status:"rate_limited"});view();fireEvent.change(screen.getByLabelText("メッセージ"),{target:{value:"first"}});fireEvent.click(screen.getByRole("button",{name:"送信"}));await screen.findByText("メッセージを送信できません。");fireEvent.change(screen.getByLabelText("メッセージ"),{target:{value:"changed"}});fireEvent.click(screen.getByRole("button",{name:"送信"}));await screen.findByText("しばらくしてから再度お試しください。");expect(m.send.mock.calls[0][1]).not.toBe(m.send.mock.calls[1][1]);});
it("survives rejected mark read silently",async()=>{m.read.mockRejectedValue(Error("private"));view();await act(async()=>{});expect(screen.getByRole("status")).toHaveTextContent("");});

const range=(first:number,last:number)=>Array.from({length:last-first+1},(_,i)=>message(first+i));
async function trigger(kind:string){
 if(kind==="send"){
  fireEvent.change(screen.getByLabelText("メッセージ"),{target:{value:"hello"}});
  fireEvent.click(screen.getByRole("button",{name:"送信"}));
 }else if(kind==="button")fireEvent.click(screen.getByRole("button",{name:"新しいメッセージを確認"}));
 else await act(async()=>{(kind==="focus"?window:document).dispatchEvent(new Event(kind==="focus"?"focus":"visibilitychange"));});
}
it.each(["button","focus","visibility","send"])("backfills multiple disjoint pages before marking read via %s",async kind=>{
 const newest={status:"ok",messages:range(96,125),hasOlder:true};
 m.latest.mockResolvedValue(newest);m.send.mockResolvedValue(newest);
 m.older.mockImplementation(async(_id,before)=>({status:"ok",messages:range(Math.max(1,before-30),before-1),hasOlder:before>31}));
 view(range(1,30));await trigger(kind);
 await screen.findByText("body 31");await screen.findByText("body 125");
 expect(m.older.mock.calls.map(c=>c[1])).toEqual([96,66,36]);
 expect(screen.getByRole("log").querySelectorAll("li")).toHaveLength(125);
 expect(m.read).toHaveBeenLastCalledWith(conversation.id,125);
 expect(screen.queryByRole("button",{name:"以前のメッセージ"})).not.toBeInTheDocument();
});
it.each(["button","focus","visibility","send"])("enables older paging after an empty room gets 31 messages via %s",async kind=>{
 const newest={status:"ok",messages:range(2,31),hasOlder:true};
 m.latest.mockResolvedValue(newest);m.send.mockResolvedValue(newest);
 m.older.mockResolvedValue({status:"ok",messages:[message(1)],hasOlder:false});
 view([]);await trigger(kind);
 fireEvent.click(await screen.findByRole("button",{name:"以前のメッセージ"}));
 await screen.findByText("body 1");expect(m.older).toHaveBeenCalledWith(conversation.id,2);
 expect(screen.getByRole("log").querySelectorAll("li")).toHaveLength(31);
});
it("keeps the original older cursor available after a newest-page backfill",async()=>{
 m.latest.mockResolvedValue({status:"ok",messages:range(72,101),hasOlder:true});
 m.older.mockResolvedValueOnce({status:"ok",messages:range(42,71),hasOlder:true}).mockResolvedValueOnce({status:"ok",messages:range(12,41),hasOlder:true}).mockResolvedValueOnce({status:"ok",messages:range(1,11),hasOlder:false});
 view(range(12,41),true);await trigger("button");await screen.findByText("body 101");
 fireEvent.click(screen.getByRole("button",{name:"以前のメッセージ"}));await screen.findByText("body 1");
 expect(m.older.mock.calls.map(c=>c[1])).toEqual([72,42,12]);
 expect(screen.getByRole("log").querySelectorAll("li")).toHaveLength(101);
});
it("does not publish or mark a disjoint newest page read when backfill fails, then recovers",async()=>{
 m.latest.mockResolvedValue({status:"ok",messages:range(32,61),hasOlder:true});
 m.older.mockResolvedValueOnce({status:"unavailable"}).mockResolvedValueOnce({status:"ok",messages:range(2,31),hasOlder:true});
 view(range(1,30));await trigger("button");await screen.findByText("メッセージを表示できません。");
 expect(screen.queryByText("body 61")).not.toBeInTheDocument();expect(m.read).toHaveBeenCalledTimes(1);
 await trigger("button");await screen.findByText("body 31");expect(m.read).toHaveBeenLastCalledWith(conversation.id,61);
});

it("opens and sends at the bottom of the log and shows Tokyo time",async()=>{
 const height=vi.spyOn(HTMLElement.prototype,"scrollHeight","get").mockReturnValue(1000);
 m.send.mockResolvedValue({status:"ok",messages:[message(1),message(2,true)],hasOlder:false});
 view();
 const log=screen.getByRole("log");expect(log.scrollTop).toBe(1000);expect(log).toHaveTextContent("21:34");
 log.scrollTop=0;
 fireEvent.change(screen.getByLabelText("メッセージ"),{target:{value:"hello"}});fireEvent.click(screen.getByRole("button",{name:"送信"}));
 await screen.findByText("body 2");expect(log.scrollTop).toBe(1000);
 height.mockRestore();
});
it("MOD-001: a hidden message shows only the fixed placeholder, for either side, with no report control",()=>{
 view([{...message(1),hidden:true,body:"stored placeholder"},{...message(2,true),hidden:true,body:"stored placeholder"},message(3)]);
 const items=screen.getAllByRole("listitem");
 for(const i of [0,1]){expect(items[i]).toHaveTextContent("この発言は運営により非表示になりました。");expect(items[i]).not.toHaveTextContent("stored placeholder");expect(items[i].querySelector("button")).toBeNull();}
 expect(items[2]).toHaveTextContent("body 3");expect(items[2].querySelector("button")).not.toBeNull();
});
