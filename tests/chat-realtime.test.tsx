import {it,expect,vi,beforeEach,afterEach} from "vitest";
import {render,screen,fireEvent,act,cleanup} from "@testing-library/react";
const m=vi.hoisted(()=>({latest:vi.fn(),read:vi.fn(),create:vi.fn(),auth:vi.fn(),channel:vi.fn(),on:vi.fn(),subscribe:vi.fn(),remove:vi.fn(),event:undefined as undefined|((payload?:unknown)=>void),status:undefined as undefined|((s:string)=>void)}));
vi.mock("@/lib/supabase/browser",()=>({createBrowserSupabase:m.create}));
vi.mock("@/server/chat-actions",()=>({latestMessages:m.latest,markRead:m.read,olderMessages:vi.fn(),sendChatMessage:vi.fn()}));
vi.mock("@/components/safety-controls-live",()=>({SafetyControlsLive:({onBlocked}:{onBlocked?:()=>void})=>onBlocked?<button onClick={onBlocked}>block test</button>:null}));
import {ChatRoomLive} from "@/components/chat-room-live";
const id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const msg=(id:number)=>({id,mine:false,body:`RPC message ${id}`,createdAt:"2026-01-01T00:00:00Z",hidden:false});
const page={status:"ok",messages:[msg(2)],hasOlder:false};
const channel={on:m.on,subscribe:m.subscribe};
const fetchSpy=vi.spyOn(globalThis,"fetch").mockRejectedValue(Error("no network"));
const socket=vi.fn(function(){throw Error("no WebSocket");});
beforeEach(()=>{
 vi.clearAllMocks();vi.stubGlobal("WebSocket",socket);
 m.latest.mockResolvedValue(page);m.read.mockResolvedValue({status:"ok"});m.auth.mockResolvedValue(undefined);
 m.create.mockReturnValue({channel:m.channel,removeChannel:m.remove,realtime:{setAuth:m.auth}});m.channel.mockReturnValue(channel);
 m.on.mockImplementation((_type,_filter,cb)=>{m.event=cb;return channel;});
 m.subscribe.mockImplementation(cb=>{m.status=cb;return channel;});
});
afterEach(()=>{cleanup();expect(fetchSpy).not.toHaveBeenCalled();expect(socket).not.toHaveBeenCalled();vi.unstubAllGlobals();});
function renderRoom(){return render(<ChatRoomLive conversation={{id,partner:{name:"Partner",photoId:null},latest:null,unread:false}} messages={[msg(1)]} hasOlder={false}/>);}
async function view(){let result!:ReturnType<typeof renderRoom>;await act(async()=>{result=renderRoom();});return result;}
async function event(payload?:unknown){await act(async()=>m.event!(payload));}
async function status(s:string){await act(async()=>m.status!(s));}
it("subscribes with the exact room filter and renders only RPC data, never payload fields",async()=>{
 await view();expect(m.channel).toHaveBeenCalledTimes(1);
 expect(m.on).toHaveBeenCalledWith("postgres_changes",{event:"INSERT",schema:"public",table:"messages",filter:`conversation_id=eq.${id}`},expect.any(Function));
 const payload=new Proxy({sender_id:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",body:"PAYLOAD SECRET"},{get(){throw Error("payload read");}});
 await event(payload);expect(m.latest).toHaveBeenCalledExactlyOnceWith(id);expect(screen.getByText("RPC message 2")).toBeInTheDocument();
 expect(document.body).not.toHaveTextContent("PAYLOAD SECRET");expect(document.body).not.toHaveTextContent("bbbbbbbb");
});
it("coalesces signals in flight into exactly one further refresh",async()=>{
 let finish!:(v:typeof page)=>void;m.latest.mockReturnValueOnce(new Promise(r=>{finish=r;}));await view();
 await event();await event();await event();expect(m.latest).toHaveBeenCalledTimes(1);
 await act(async()=>finish(page));expect(m.latest).toHaveBeenCalledTimes(2);
});
it.each(["CHANNEL_ERROR","TIMED_OUT","CLOSED"])("catches up once after %s, but not on initial subscribe",async failure=>{
 await view();await status("SUBSCRIBED");expect(m.latest).not.toHaveBeenCalled();
 await status(failure);await status("SUBSCRIBED");await status("SUBSCRIBED");expect(m.latest).toHaveBeenCalledTimes(1);
});
it.each(["unmount","block"])("removes the channel on %s and ignores late signals and statuses",async how=>{
 const v=await view();if(how==="unmount")v.unmount();else fireEvent.click(screen.getByText("block test"));
 expect(m.remove).toHaveBeenCalledExactlyOnceWith(channel);await event();await status("CHANNEL_ERROR");await status("SUBSCRIBED");expect(m.latest).not.toHaveBeenCalled();
});
it("keeps manual refresh working if client construction fails",async()=>{
 m.create.mockImplementation(()=>{throw Error("missing config");});await view();
 fireEvent.click(screen.getByRole("button",{name:"新しいメッセージを確認"}));await screen.findByText("RPC message 2");expect(m.latest).toHaveBeenCalledTimes(1);expect(m.channel).not.toHaveBeenCalled();
});
it("removes the channel when a signal fetch finds the room unavailable",async()=>{
 m.latest.mockResolvedValue({status:"not_available"});await view();await event();
 expect(screen.getByText("この会話は表示できません")).toBeInTheDocument();expect(m.remove).toHaveBeenCalledExactlyOnceWith(channel);
 await event();expect(m.latest).toHaveBeenCalledTimes(1);
});
it("discards a pending refresh when blocked during the request",async()=>{
 let finish!:(v:typeof page)=>void;m.latest.mockReturnValueOnce(new Promise(r=>{finish=r;}));await view();await event();await event();
 fireEvent.click(screen.getByText("block test"));await act(async()=>finish(page));expect(m.latest).toHaveBeenCalledTimes(1);expect(screen.queryByText("RPC message 2")).not.toBeInTheDocument();
});
it("waits for user authentication before creating or subscribing to the room channel",async()=>{
 let finish!:()=>void;m.auth.mockReturnValueOnce(new Promise<void>(resolve=>{finish=resolve;}));
 renderRoom();expect(m.auth).toHaveBeenCalledExactlyOnceWith();expect(m.channel).not.toHaveBeenCalled();expect(m.subscribe).not.toHaveBeenCalled();
 await act(async()=>finish());expect(m.channel).toHaveBeenCalledExactlyOnceWith(`chat:${id}`);expect(m.subscribe).toHaveBeenCalledTimes(1);
});
it("keeps manual refresh working and silently omits Realtime if authentication rejects",async()=>{
 m.auth.mockRejectedValueOnce(Error("private auth failure"));await view();
 expect(m.channel).not.toHaveBeenCalled();expect(m.subscribe).not.toHaveBeenCalled();expect(screen.getByRole("status")).toHaveTextContent("");
 fireEvent.click(screen.getByRole("button",{name:"新しいメッセージを確認"}));await screen.findByText("RPC message 2");expect(m.latest).toHaveBeenCalledTimes(1);
});
it.each(["unmount","block"])("never creates a channel if %s happens before authentication resolves",async how=>{
 let finish!:()=>void;m.auth.mockReturnValueOnce(new Promise<void>(resolve=>{finish=resolve;}));
 const v=renderRoom();if(how==="unmount")v.unmount();else fireEvent.click(screen.getByText("block test"));
 await act(async()=>finish());expect(m.channel).not.toHaveBeenCalled();expect(m.subscribe).not.toHaveBeenCalled();expect(m.remove).not.toHaveBeenCalled();
});
