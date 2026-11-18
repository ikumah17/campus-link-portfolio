import {render,screen,fireEvent,waitFor,cleanup} from "@testing-library/react";
import {it,expect,vi,beforeEach,afterEach} from "vitest";
const m=vi.hoisted(()=>({update:vi.fn(),suspend:vi.fn(),reactivate:vi.fn(),refresh:vi.fn()}));
vi.mock("next/navigation",()=>({useRouter:()=>({refresh:m.refresh})}));
vi.mock("@/server/admin-report-actions",()=>({updateReport:m.update,suspendReportTarget:m.suspend,reactivateReportTarget:m.reactivate}));
vi.mock("next/link",()=>({default:({prefetch,href,children,...props}:React.PropsWithChildren<{prefetch?:boolean;href:string}>)=><a href={href} data-prefetch={String(prefetch)} {...props}>{children}</a>}));
import {AdminReportListLive} from "@/components/admin-report-list-live";
import {AdminReportDetailLive} from "@/components/admin-report-detail-live";
import type {ReportDetail} from "@/server/admin-reports";
const report:ReportDetail={id:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",targetLabel:"対象 #12345678",context:"profile",reason:"spam",status:"open",createdAt:"2026-11-07T00:00:00Z",detail:null,evidence:{body:"evidence",createdAt:"2026-11-07T00:00:00Z"}};
let network:ReturnType<typeof vi.spyOn>;
beforeEach(()=>{vi.resetAllMocks();network=vi.spyOn(globalThis,"fetch").mockRejectedValue(Error("network"));HTMLDialogElement.prototype.showModal=function(){this.setAttribute("open","");};HTMLDialogElement.prototype.close=function(){this.removeAttribute("open");};m.update.mockResolvedValue({status:"ok"});m.suspend.mockResolvedValue({status:"ok"});});
afterEach(()=>{cleanup();expect(network).not.toHaveBeenCalled();vi.restoreAllMocks();});
it("tabs, no prefetch on detail links and empty state",()=>{const {container,unmount}=render(<AdminReportListLive reports={[report]} status="open"/>);expect(screen.getByRole("link",{name:"未対応"})).toHaveAttribute("aria-current","page");expect(container.querySelector(`a[href='/admin/reports/${report.id}']`)).toHaveAttribute("data-prefetch","false");expect(container.textContent).not.toMatch(/架空|デモ/);unmount();render(<AdminReportListLive reports={[]} status="dismissed"/>);expect(screen.getByText("この状態の通報はありません。")).toBeInTheDocument();});
it("focuses heading and updates only one action while pending",async()=>{let finish!:(r:{status:string})=>void;m.update.mockImplementation(()=>new Promise(r=>{finish=r;}));render(<AdminReportDetailLive report={report}/>);expect(screen.getByRole("heading",{name:"通報の詳細"})).toHaveFocus();expect(screen.getByText("evidence")).toBeInTheDocument();fireEvent.change(screen.getByLabelText("対応メモ（任意）"),{target:{value:"memo"}});fireEvent.click(screen.getByRole("button",{name:"確認中にする"}));expect(screen.getByRole("button",{name:"アカウントを停止"})).toBeDisabled();expect(m.update).toHaveBeenCalledExactlyOnceWith(report.id,"triaged","memo");finish({status:"ok"});await screen.findByText("確認中に変更しました。");expect(m.refresh).toHaveBeenCalled();});
it.each([["invalid_state","状態が変わったため操作できません。"],["invalid","メモは1000文字以内で入力してください。"],["forbidden","この操作の権限がありません。"],["unauthenticated","再度ログインしてください。"],["unavailable","現在操作できません。時間をおいて再度お試しください。"]])("shows update %s",async(status,message)=>{m.update.mockResolvedValue({status});render(<AdminReportDetailLive report={report}/>);fireEvent.click(screen.getByRole("button",{name:"確認中にする"}));await screen.findByText(message);});
it("dialog traps focus, cancels and returns focus; suspension is guarded",async()=>{render(<AdminReportDetailLive report={report}/>);const trigger=screen.getByRole("button",{name:"アカウントを停止"});fireEvent.click(trigger);const cancel=screen.getByRole("button",{name:"キャンセル"}),confirm=screen.getByRole("button",{name:"停止する"});expect(cancel).toHaveFocus();fireEvent.keyDown(cancel,{key:"Tab",shiftKey:true});expect(confirm).toHaveFocus();fireEvent.keyDown(confirm,{key:"Tab"});expect(cancel).toHaveFocus();fireEvent(screen.getByRole("dialog"),new Event("cancel",{cancelable:true}));expect(trigger).toHaveFocus();fireEvent.click(trigger);fireEvent.click(screen.getByRole("button",{name:"停止する"}));await screen.findByText("アカウントを停止しました。");expect(m.suspend).toHaveBeenCalledExactlyOnceWith(report.id,"spam");await waitFor(()=>expect(trigger).toHaveFocus());});
it.each([["invalid_state","この利用者は停止できません。"],["forbidden","この操作の権限がありません。"]])("shows suspension %s",async(status,message)=>{m.suspend.mockResolvedValue({status});render(<AdminReportDetailLive report={report}/>);fireEvent.click(screen.getByRole("button",{name:"アカウントを停止"}));fireEvent.click(screen.getByRole("button",{name:"停止する"}));await screen.findByText(message);});

it("keeps focus inside the dialog throughout pending suspension and ignores Escape",async()=>{
 let finish!:(r:{status:string})=>void;
 m.suspend.mockImplementation(()=>new Promise(r=>{finish=r;}));
 render(<AdminReportDetailLive report={report}/>);
 const trigger=screen.getByRole("button",{name:"アカウントを停止"});
 fireEvent.click(trigger);
 const dialog=screen.getByRole("dialog"),confirm=screen.getByRole("button",{name:"停止する"});
 confirm.focus();
 fireEvent.click(confirm);
 expect(confirm).toBeDisabled();
 expect(dialog).toHaveFocus();
 for(const shiftKey of [false,true]){
  fireEvent.keyDown(document.activeElement!,{key:"Tab",shiftKey});
  expect(dialog).toHaveFocus();
 }
 // Native Escape dispatches a cancel event; it must not dismiss an in-flight action.
 const cancel=new Event("cancel",{cancelable:true});
 fireEvent(dialog,cancel);
 expect(cancel.defaultPrevented).toBe(true);
 expect(dialog).toHaveAttribute("open");
 expect(dialog).toHaveFocus();
 fireEvent.click(confirm);
 expect(m.suspend).toHaveBeenCalledTimes(1);
 finish({status:"ok"});
 await screen.findByText("アカウントを停止しました。");
 await waitFor(()=>expect(trigger).toHaveFocus());
 expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("reactivation dialog traps focus, names only the label and returns focus on Escape",()=>{
 render(<AdminReportDetailLive report={report}/>);const trigger=screen.getByRole("button",{name:"停止を解除"});fireEvent.click(trigger);
 expect(screen.getByText(`${report.targetLabel}のアカウントを再開します。他の利用者に再び表示されるようになります。`)).toBeInTheDocument();
 const cancel=screen.getByRole("button",{name:"キャンセル"}),confirm=screen.getByRole("button",{name:"再開する"});expect(cancel).toHaveFocus();
 fireEvent.keyDown(cancel,{key:"Tab",shiftKey:true});expect(confirm).toHaveFocus();fireEvent.keyDown(confirm,{key:"Tab"});expect(cancel).toHaveFocus();
 fireEvent(screen.getByRole("dialog"),new Event("cancel",{cancelable:true}));expect(trigger).toHaveFocus();expect(m.reactivate).not.toHaveBeenCalled();
});
it("reactivation keeps pending focus and serializes every page action",async()=>{
 let finish!:(r:{status:string})=>void;m.reactivate.mockImplementation(()=>new Promise(r=>{finish=r;}));
 render(<AdminReportDetailLive report={report}/>);const trigger=screen.getByRole("button",{name:"停止を解除"});fireEvent.click(trigger);const confirm=screen.getByRole("button",{name:"再開する"});fireEvent.click(confirm);
 const dialog=screen.getByRole("dialog");expect(dialog).toHaveFocus();
 for(const shiftKey of [false,true]){fireEvent.keyDown(dialog,{key:"Tab",shiftKey});expect(dialog).toHaveFocus();}
 fireEvent(dialog,new Event("cancel",{cancelable:true}));expect(dialog).toHaveAttribute("open");
 for(const name of ["停止を解除","アカウントを停止","確認中にする","見送りにする"]){const button=screen.getByRole("button",{name});expect(button).toBeDisabled();fireEvent.click(button);}
 fireEvent.click(confirm);expect(m.reactivate).toHaveBeenCalledExactlyOnceWith(report.id);expect(m.update).not.toHaveBeenCalled();expect(m.suspend).not.toHaveBeenCalled();
 finish({status:"ok"});await screen.findByText("アカウントを再開しました。");await waitFor(()=>expect(trigger).toHaveFocus());expect(m.refresh).toHaveBeenCalledTimes(1);
});
it.each([["invalid_state","この利用者は停止されていません。"],["forbidden","この操作の権限がありません。"],["unavailable","現在操作できません。時間をおいて再度お試しください。"],["unauthenticated","現在操作できません。時間をおいて再度お試しください。"],["invalid","現在操作できません。時間をおいて再度お試しください。"]])("shows reactivation %s",async(status,message)=>{
 m.reactivate.mockResolvedValue({status});render(<AdminReportDetailLive report={report}/>);fireEvent.click(screen.getByRole("button",{name:"停止を解除"}));fireEvent.click(screen.getByRole("button",{name:"再開する"}));await screen.findByText(message);expect(m.refresh).not.toHaveBeenCalled();
});
it("reactivation handles thrown failures and disables missing targets",async()=>{
 m.reactivate.mockRejectedValue(Error("failure"));const {unmount}=render(<AdminReportDetailLive report={report}/>);fireEvent.click(screen.getByRole("button",{name:"停止を解除"}));fireEvent.click(screen.getByRole("button",{name:"再開する"}));await screen.findByText("現在操作できません。時間をおいて再度お試しください。");unmount();render(<AdminReportDetailLive report={{...report,targetLabel:null}}/>);expect(screen.getByRole("button",{name:"停止を解除"})).toBeDisabled();
});
