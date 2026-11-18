// MOD-001: the report detail's content section, its confirmation dialog and the single status region.
import {render,screen,fireEvent,waitFor,cleanup,within} from "@testing-library/react";
import {it,expect,vi,beforeEach,afterEach} from "vitest";
const m=vi.hoisted(()=>({update:vi.fn(),suspend:vi.fn(),reactivate:vi.fn(),hide:vi.fn(),unhide:vi.fn(),refresh:vi.fn()}));
vi.mock("next/navigation",()=>({useRouter:()=>({refresh:m.refresh})}));
vi.mock("@/server/admin-report-actions",()=>({updateReport:m.update,suspendReportTarget:m.suspend,reactivateReportTarget:m.reactivate,hideReportContent:m.hide,unhideReportContent:m.unhide}));
vi.mock("next/link",()=>({default:({href,children,...props}:React.PropsWithChildren<{href:string;prefetch?:boolean}>)=><a href={href} {...props}>{children}</a>}));
import {AdminReportDetailLive} from "@/components/admin-report-detail-live";
import type {ReportContentItem,ReportDetail} from "@/server/admin-reports";
const id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",photo="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const report:ReportDetail={id,targetLabel:"対象 #12345678",context:"message",reason:"harassment",status:"open",createdAt:"2026-11-17T00:00:00Z",detail:null,evidence:null};
const item=(patch:Partial<ReportContentItem>):ReportContentItem=>({item:"message",ref:null,position:null,body:"架空の不適切な発言",hidden:false,hiddenAt:null,...patch});
let network:ReturnType<typeof vi.spyOn>;
beforeEach(()=>{vi.resetAllMocks();network=vi.spyOn(globalThis,"fetch").mockRejectedValue(Error("network"));HTMLDialogElement.prototype.showModal=function(){this.setAttribute("open","");};HTMLDialogElement.prototype.close=function(){this.removeAttribute("open");};m.hide.mockResolvedValue({status:"ok"});m.unhide.mockResolvedValue({status:"ok"});});
afterEach(()=>{cleanup();expect(network).not.toHaveBeenCalled();vi.restoreAllMocks();});
const view=(content:ReportContentItem[]|null,r=report)=>render(<AdminReportDetailLive report={r} content={content}/>);

it("shows the message, its state and a confirmed hide that reports through the page's one status region",async()=>{
 view([item({})]);
 const section=screen.getByRole("region",{name:"通報された内容"});
 expect(within(section).getByText("架空の不適切な発言")).toBeInTheDocument();expect(within(section).getByText("表示中")).toBeInTheDocument();
 const trigger=screen.getByRole("button",{name:"メッセージの内容を非表示にする"});expect(trigger).toHaveTextContent("内容を非表示にする");
 fireEvent.click(trigger);
 const dialog=screen.getByRole("dialog",{name:"内容の非表示"});
 expect(dialog).toHaveAccessibleDescription("メッセージを非表示にします。両方の参加者には「この発言は運営により非表示になりました。」と表示されます。後から表示を戻せます。");
 const cancel=within(dialog).getByRole("button",{name:"キャンセル"}),confirm=within(dialog).getByRole("button",{name:"非表示にする"});
 expect(cancel).toHaveFocus();fireEvent.keyDown(cancel,{key:"Tab",shiftKey:true});expect(confirm).toHaveFocus();fireEvent.keyDown(confirm,{key:"Tab"});expect(cancel).toHaveFocus();
 fireEvent(dialog,new Event("cancel",{cancelable:true}));expect(screen.queryByRole("dialog")).not.toBeInTheDocument();expect(trigger).toHaveFocus();expect(m.hide).not.toHaveBeenCalled();
 fireEvent.click(trigger);fireEvent.click(within(screen.getByRole("dialog")).getByRole("button",{name:"非表示にする"}));
 await waitFor(()=>expect(screen.getAllByRole("status")).toHaveLength(1));
 expect(await screen.findByText("内容を非表示にしました。")).toHaveAttribute("role","status");
 expect(m.hide).toHaveBeenCalledExactlyOnceWith(id,"message",null);expect(m.refresh).toHaveBeenCalledTimes(1);
 await waitFor(()=>expect(trigger).toHaveFocus());expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("a hidden message offers only the undo, and a pending action locks every page action",async()=>{
 let finish!:(r:{status:string})=>void;m.unhide.mockImplementation(()=>new Promise(r=>{finish=r;}));
 view([item({hidden:true,hiddenAt:"2026-11-17T00:00:00Z"})]);
 expect(screen.getByText("非表示（運営）")).toBeInTheDocument();expect(screen.queryByRole("button",{name:/内容を非表示にする/})).not.toBeInTheDocument();
 fireEvent.click(screen.getByRole("button",{name:"メッセージの表示を戻す"}));
 const dialog=screen.getByRole("dialog",{name:"表示を戻す"});expect(dialog).toHaveAccessibleDescription("メッセージを、両方の参加者に再び表示します。");
 const confirm=within(dialog).getByRole("button",{name:"戻す"});fireEvent.click(confirm);
 expect(dialog).toHaveFocus();expect(confirm).toBeDisabled();
 for(const name of ["アカウントを停止","停止を解除","確認中にする","見送りにする"])expect(screen.getByRole("button",{name})).toBeDisabled();
 fireEvent(dialog,new Event("cancel",{cancelable:true}));expect(dialog).toHaveAttribute("open");fireEvent.click(confirm);
 expect(m.unhide).toHaveBeenCalledExactlyOnceWith(id,"message");
 finish({status:"ok"});await screen.findByText("表示を戻しました。");expect(screen.getByRole("button",{name:"アカウントを停止"})).toBeEnabled();
});

it("a profile report lists the one bio and every photo; the bio and photos cannot be undone",async()=>{
 view([item({item:"bio",body:"架空の紹介"}),item({item:"photo",ref:photo,position:1,body:null})],{...report,context:"profile"});
 expect(screen.getByRole("img",{name:"写真 2"})).toHaveAttribute("src",`/admin/reports/${id}/photos/${photo}`);
 expect(screen.queryByText(/恋愛|友達向け/)).not.toBeInTheDocument();
 fireEvent.click(screen.getByRole("button",{name:"写真 2の内容を非表示にする"}));
 expect(screen.getByRole("dialog")).toHaveAccessibleDescription("写真 2を非表示にします。この写真は削除され、元に戻せません。最後の1枚の場合、本人が新しい写真を登録するまでプロフィールは表示されなくなります。");
 fireEvent.click(screen.getByRole("button",{name:"非表示にする"}));await screen.findByText("内容を非表示にしました。");
 expect(m.hide).toHaveBeenLastCalledWith(id,"photo",photo);
 fireEvent.click(screen.getByRole("button",{name:"自己紹介の内容を非表示にする"}));
 expect(screen.getByRole("dialog")).toHaveAccessibleDescription("自己紹介を非表示にします。本人が新しく書き直すまで、この自己紹介はどこにも表示されなくなります。元に戻せません。");
 fireEvent.click(screen.getByRole("button",{name:"非表示にする"}));await waitFor(()=>expect(m.hide).toHaveBeenLastCalledWith(id,"bio",null));
});
it("a hidden bio offers no action",()=>{
 view([item({item:"bio",body:null,hidden:true})],{...report,context:"profile"});
 expect(screen.queryByRole("button",{name:"自己紹介の内容を非表示にする"})).not.toBeInTheDocument();
});

it.each([["invalid_state","状態が変わったため操作できません。"],["forbidden","この操作の権限がありません。"],["unauthenticated","再度ログインしてください。"],["invalid","現在操作できません。時間をおいて再度お試しください。"],["unavailable","現在操作できません。時間をおいて再度お試しください。"]])("shows hide %s without refreshing",async(status,message)=>{
 m.hide.mockResolvedValue({status});view([item({item:"request_message"})]);
 fireEvent.click(screen.getByRole("button",{name:"申請メッセージの内容を非表示にする"}));fireEvent.click(screen.getByRole("button",{name:"非表示にする"}));
 await screen.findByText(message);expect(m.refresh).not.toHaveBeenCalled();
});

it("thrown failures, unreadable content, empty content and the old page without content",async()=>{
 m.hide.mockRejectedValue(Error("secret"));const first=view([item({})]);fireEvent.click(screen.getByRole("button",{name:"メッセージの内容を非表示にする"}));fireEvent.click(screen.getByRole("button",{name:"非表示にする"}));
 await screen.findByText("現在操作できません。時間をおいて再度お試しください。");first.unmount();
 const second=view(null);expect(screen.getByText("内容を表示できません。")).toBeInTheDocument();second.unmount();
 const third=view([]);expect(screen.getByText("非表示にできる内容はありません。")).toBeInTheDocument();third.unmount();
 render(<AdminReportDetailLive report={report}/>);expect(screen.queryByRole("region",{name:"通報された内容"})).not.toBeInTheDocument();
});
