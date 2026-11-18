import { act, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { DemoLikesProvider } from "@/components/demo-likes-provider";
import { DemoChatProvider, useChatGateway } from "@/components/demo-chat-provider";
import { DemoSafetyProvider, useSafetyGateway } from "@/components/demo-safety-provider";
import { ProfileDetail } from "@/components/profile-detail";
import { ChatRoom } from "@/components/chat-room";
import { Discover } from "@/components/discover";
import { demoProfiles } from "@/data/demo-profiles";
import { type ReactNode } from "react";

function Wrapper({ children }: { children: ReactNode }) {
  return <DemoLikesProvider><DemoChatProvider><DemoSafetyProvider>{children}</DemoSafetyProvider></DemoChatProvider></DemoLikesProvider>;
}
describe("safety dialogs", () => {
  it("applies shared blocking before React rerenders the chat provider", async () => {
    const { result } = renderHook(() => ({ safety: useSafetyGateway()!, chat: useChatGateway() }), { wrapper: Wrapper });
    await act(async () => {
      await result.current.safety.blockUser("demo-4");
      expect((await result.current.chat.sendMessage("demo-4", "blocked-send", "hello")).code).toBe("not_available");
      expect((await result.current.chat.listMyConversations()).data).toEqual([]);
    });
  });
  it("traps block confirmation focus, cancels via Escape and returns to its trigger", async () => {
    const user = userEvent.setup({ delay: null });
    render(<Wrapper><ProfileDetail profile={demoProfiles[0]} /></Wrapper>);
    const trigger = screen.getByRole("button", { name: "ブロック" });
    await user.click(trigger);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/相手に通知は届きません/)).toBeInTheDocument();
    const confirm = within(dialog).getByRole("button", { name: "ブロックする" });
    expect(confirm).toHaveFocus();
    await user.tab({ shift: true }); expect(within(dialog).getByRole("button", { name: "キャンセル" })).toHaveFocus();
    await user.tab(); expect(confirm).toHaveFocus();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("counts code points, submits once, announces and restores focus after a report", async () => {
    const user = userEvent.setup({ delay: null });
    render(<Wrapper><ProfileDetail profile={demoProfiles[0]} /></Wrapper>);
    const trigger = screen.getByRole("button", { name: "通報" });
    await user.click(trigger);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getAllByRole("radio")).toHaveLength(6);
    const detail = within(dialog).getByLabelText("詳細（任意）");
    const submit = within(dialog).getByRole("button", { name: "通報する（デモ）" });
    fireEvent.change(detail, { target: { value: "😀".repeat(1001) } });
    expect(submit).toBeDisabled(); expect(detail).toHaveAttribute("aria-invalid", "true");
    fireEvent.change(detail, { target: { value: "😀".repeat(1000) } });
    expect(within(dialog).getByText("1000 / 1000文字")).toBeInTheDocument();
    const first = within(dialog).getByRole("radio", { name: "嫌がらせ" });
    first.focus(); await user.tab({ shift: true }); expect(within(dialog).getByRole("button", { name: "キャンセル" })).toHaveFocus();
    await user.tab(); expect(first).toHaveFocus();
    await user.click(submit);
    expect(within(dialog).getByRole("status")).toHaveTextContent("通報を受け付けました（デモ）");
    await user.keyboard("{Escape}"); await waitFor(() => expect(trigger).toHaveFocus());
  });
  it("offers a partner-only message report with a quote and focus return", async () => {
    const user = userEvent.setup({ delay: null });
    render(<Wrapper><ChatRoom id="demo-4" /></Wrapper>);
    const trigger = await screen.findByRole("button", { name: "メッセージ 36 を通報" });
    expect(screen.queryByRole("button", { name: "メッセージ 35 を通報" })).not.toBeInTheDocument();
    await user.click(trigger);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("blockquote")).toHaveTextContent("架空の会話 36");
    await user.click(within(dialog).getByRole("button", { name: "通報する（デモ）" }));
    expect(within(dialog).getByRole("status")).toHaveTextContent("通報を受け付けました（デモ）");
    await user.keyboard("{Escape}"); await waitFor(() => expect(trigger).toHaveFocus());
    const menu = screen.getByRole("button", { name: "ブロック・通報" });
    await user.click(menu); await user.keyboard("{Escape}"); await waitFor(() => expect(menu).toHaveFocus());
    for (const name of ["ブロック", "通報"]) {
      await user.click(menu);
      await user.click(within(screen.getByRole("dialog")).getByRole("button", { name }));
      await user.keyboard("{Escape}"); await waitFor(() => expect(menu).toHaveFocus());
    }
  });
  it("blocks a profile and filters Discover using shared state", async () => {
    const user = userEvent.setup({ delay: null });
    const { rerender } = render(<Wrapper><ProfileDetail profile={demoProfiles[0]} /></Wrapper>);
    await user.click(screen.getByRole("button", { name: "ブロック" }));
    await user.click(screen.getByRole("button", { name: "ブロックする" }));
    expect(within(screen.getByRole("dialog")).getByRole("status")).toHaveTextContent("ブロックしました");
    await user.click(screen.getByRole("button", { name: "閉じる" }));
    expect(screen.getByRole("heading")).toHaveTextContent("このプロフィールは表示できません");
    rerender(<Wrapper><Discover /></Wrapper>);
    expect(screen.queryByRole("link", { name: `${demoProfiles[0].name}のプロフィールを見る` })).not.toBeInTheDocument();
    expect(await screen.findByRole("link", { name: `${demoProfiles[2].name}のプロフィールを見る` })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: `${demoProfiles[0].name}のプロフィールを見る` })).not.toBeInTheDocument();
  });
});
