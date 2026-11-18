vi.mock("@/server/safety-actions",()=>({blockProfile:vi.fn(),blockConversation:vi.fn(),unblockUser:vi.fn(),reportProfile:vi.fn(),reportConversation:vi.fn(),reportMessage:vi.fn()}));
const m=vi.hoisted(()=>({like:vi.fn(),unlike:vi.fn()}));
vi.mock("next/navigation",()=>({useRouter:()=>({refresh:vi.fn()})}));
vi.mock("@/server/like-actions",()=>({likeUser:m.like,unlikeUser:m.unlike}));
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { expect, it, vi, afterEach } from "vitest";
vi.mock("@/components/main-nav", () => ({ MainNav: () => null }));
import { ProfileDetailLive } from "@/components/profile-detail-live";
import { likeMessages } from "@/components/like-controls";
const conv="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const profile={id:"person",name:"葵",age:22,gender:"female" as const,school:"大学",department:null,class:null,bio:"紹介",purposes:["hobby" as const,"talk" as const],hobbies:["読書"],photoIds:["first","second"]};
const none={iLiked:false,likedMe:false,conversationId:null};
it("renders private-authorized fields, ordered photos and the purposes, with no mode",()=>{
  const { container } = render(<ProfileDetailLive profile={profile} likeState={none} />);
  expect(screen.getAllByRole("img").map(img=>[img.getAttribute("src"),img.getAttribute("alt")])).toEqual([["/media/photos/first","葵の写真 1"],["/media/photos/second","葵の写真 2"]]);
  expect(container.textContent).not.toMatch(/架空|デモ|null|モード|恋愛|申請/);
  expect(screen.getByText("目的")).toBeInTheDocument();
  expect(screen.getByText("趣味仲間がほしい・話し相手がほしい")).toBeInTheDocument();
  expect(screen.getByText("ブロック")).toBeEnabled();
  expect(screen.getByRole("link",{name:"一覧へ戻る"})).toHaveAttribute("href","/");
});
it("leaves out empty rows",()=>{
  render(<ProfileDetailLive profile={{...profile,bio:"",purposes:[],hobbies:[]}} likeState={none} />);
  for(const label of ["自己紹介","趣味","目的"])expect(screen.queryByText(label)).not.toBeInTheDocument();
});
it.each([
 ["nothing yet",none,"葵にいいね",null],
 ["liked",{...none,iLiked:true},"葵へのいいねを取り消す","いいね済み"],
 ["liked me",{...none,likedMe:true},"葵にいいねを返す","あなたにいいねしています"],
 ["unknown",null,"葵にいいね",null],
] as const)("shows the %s state",(_name,likeState,button,text)=>{
 render(<ProfileDetailLive profile={profile} likeState={likeState} />);
 expect(screen.getByRole("button",{name:button})).toBeInTheDocument();
 if(text)expect(screen.getByText(text)).toBeInTheDocument();
});
it("shows the talk for a match",()=>{render(<ProfileDetailLive profile={profile} likeState={{...none,conversationId:conv}} />);expect(screen.getByRole("link",{name:"トークを開く"})).toHaveAttribute("href",`/talk/${conv}`);expect(screen.queryByRole("button",{name:/いいね/})).toBeNull()});

const fetchSpy=vi.spyOn(globalThis,"fetch").mockRejectedValue(new Error("network forbidden"));
afterEach(()=>{expect(fetchSpy).not.toHaveBeenCalled();vi.clearAllMocks()});
it("likes once at a time, then takes it back",async()=>{
 let resolve!:(v:{status:string})=>void;m.like.mockReturnValue(new Promise(r=>{resolve=r}));
 render(<ProfileDetailLive profile={profile} likeState={none} />);
 fireEvent.click(screen.getByRole("button",{name:"葵にいいね"}));expect(screen.getByRole("button",{name:"葵にいいね"})).toBeDisabled();fireEvent.click(screen.getByRole("button",{name:"葵にいいね"}));expect(m.like).toHaveBeenCalledTimes(1);expect(m.like).toHaveBeenCalledWith("person");
 resolve({status:"ok"});await waitFor(()=>expect(screen.getByRole("status")).toHaveTextContent("いいねしました。"));expect(screen.getByText("いいね済み")).toBeInTheDocument();
 m.unlike.mockResolvedValue({status:"ok"});fireEvent.click(screen.getByRole("button",{name:"葵へのいいねを取り消す"}));
 await waitFor(()=>expect(screen.getByRole("status")).toHaveTextContent("いいねを取り消しました。"));expect(m.unlike).toHaveBeenCalledWith("person");expect(screen.getByRole("button",{name:"葵にいいね"})).toBeInTheDocument();
});
it("likes back to a match and opens its talk",async()=>{
 m.like.mockResolvedValue({status:"ok",conversationId:conv});render(<ProfileDetailLive profile={profile} likeState={{...none,likedMe:true}} />);
 fireEvent.click(screen.getByRole("button",{name:"葵にいいねを返す"}));
 await waitFor(()=>expect(screen.getByRole("status")).toHaveTextContent("マッチしました。トークで話せます。"));expect(screen.getByRole("link",{name:"トークを開く"})).toHaveAttribute("href",`/talk/${conv}`);
});
it.each(Object.keys(likeMessages))("shows the fixed answer %s",async status=>{
 m.like.mockResolvedValue({status});render(<ProfileDetailLive profile={profile} likeState={none} />);
 fireEvent.click(screen.getByRole("button",{name:"葵にいいね"}));
 await waitFor(()=>expect(screen.getByRole("status")).toHaveTextContent(likeMessages[status as keyof typeof likeMessages]));
 if(status==="already_connected")expect(screen.getByRole("link",{name:"トークを開く"})).toHaveAttribute("href","/talk");
 else expect(screen.getByRole("button",{name:"葵にいいね"})).toBeEnabled();
});
it("uses the fixed answer texts of docs/43 §4.3",()=>{expect(likeMessages).toMatchObject({not_available:"この相手には、いまいいねできません。",already_connected:"すでにマッチしています。",rate_limited:"今日はこれ以上いいねできません。時間をおいてお試しください。"})});
