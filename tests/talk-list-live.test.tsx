vi.mock("@/lib/supabase/browser",()=>({createBrowserSupabase:()=>{throw Error("disabled in render tests");}}));
vi.mock("next/navigation",()=>({useRouter:()=>({refresh:vi.fn()})}));
import {it,expect,vi} from "vitest";
import {render,screen} from "@testing-library/react";
vi.mock("@/components/main-nav",()=>({MainNav:()=>null}));
import {TalkListLive} from "@/components/talk-list-live";
it("renders empty list with the likes link",()=>{render(<TalkListLive conversations={[]}/>);expect(screen.getByText("つながりはまだありません。")).toBeInTheDocument();expect(screen.getByRole("link")).toHaveAttribute("href","/likes");});
it("renders photo, unread and preview without demo words or counts",()=>{const {container}=render(<TalkListLive conversations={[{id:"conversation",partner:{name:"Partner",photoId:"photo"},latest:{body:"hello",at:"now",mine:false},unread:true}]}/>);expect(screen.getByRole("presentation")).toHaveAttribute("src","/media/photos/photo");expect(screen.getByText("未読")).toBeInTheDocument();expect(screen.getByText("hello")).toBeInTheDocument();expect(container.innerHTML).not.toMatch(/架空|デモ|件|sender_id/);});

