import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ChatRoom } from "@/components/chat-room";
import { DemoChatProvider } from "@/components/demo-chat-provider";
import { createChatDemo } from "@/lib/chat-demo";
import { createDemoLikes } from "@/data/demo-likes";
import type { ChatGateway } from "@/lib/chat-gateway";

function setup(id?: string, custom?: ChatGateway) {
  const state = createDemoLikes(); const gateway = custom ?? createChatDemo(() => state);
  render(<DemoChatProvider gateway={gateway}><ChatRoom id={id ?? state.connections[0][1]} /></DemoChatProvider>);
  return gateway;
}
describe("chat room", () => {
  it("sends with button and shortcut, inserts newlines, counts codepoints, focuses and announces", async () => {
    const user = userEvent.setup({ delay: null }); const gateway = setup();
    const body = await screen.findByLabelText("メッセージ");
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    const send = screen.getByRole("button", { name: "送信" }); expect(send).toBeDisabled();
    fireEvent.change(body, { target: { value: " \n " } }); expect(send).toBeDisabled();
    fireEvent.change(body, { target: { value: "😀".repeat(2001) } }); expect(send).toBeDisabled();
    fireEvent.change(body, { target: { value: "hello😀" } }); expect(screen.getByText("6 / 2000文字")).toBeInTheDocument();
    await user.click(send); expect(await screen.findByText("hello😀")).toBeInTheDocument();
    expect(body).toHaveValue(""); expect(body).toHaveFocus(); expect(screen.getByRole("status")).toHaveTextContent("送信しました");
    await user.type(body, "second{Enter}line"); expect(body).toHaveValue("second\nline");
    await user.keyboard("{Control>}{Enter}{/Control}"); await waitFor(() => expect(body).toHaveValue(""));
    expect((await gateway.listMessages(createDemoLikes().connections[0][1])).data[0].body).toBe("second\nline");
    await user.type(body, "third"); await user.keyboard("{Meta>}{Enter}{/Meta}"); await waitFor(() => expect(body).toHaveValue(""));
    expect(screen.getByRole("status")).toHaveAttribute("role", "status");
    expect(screen.getByRole("button", { name: "ブロック・通報" })).not.toHaveAttribute("aria-disabled", "true");
  });
  it("guards a pending double send synchronously", async () => {
    const state = createDemoLikes(); const real = createChatDemo(() => state);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const sendMessage = vi.fn(async (...args: Parameters<ChatGateway["sendMessage"]>) => { await gate; return real.sendMessage(...args); });
    setup(undefined, { ...real, sendMessage });
    fireEvent.change(await screen.findByLabelText("メッセージ"), { target: { value: "once" } });
    const form = screen.getByRole("button", { name: "送信" }).closest("form")!;
    fireEvent.submit(form); fireEvent.submit(form); expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0][1]).toMatch(/^[0-9a-f-]{36}$/);
    await act(async () => { release(); }); expect(await screen.findAllByText("once")).toHaveLength(1);
  });
  it("loads older messages and marks the latest incoming message read", async () => {
    const user = userEvent.setup({ delay: null }); const gateway = setup();
    await screen.findByRole("log");
    await waitFor(async () => expect((await gateway.listMyConversations()).data[0].unread).toBe(false));
    expect(within(screen.getByRole("log")).getAllByRole("listitem")).toHaveLength(30);
    await user.click(screen.getByRole("button", { name: "以前のメッセージ" }));
    expect(within(screen.getByRole("log")).getAllByRole("listitem")).toHaveLength(36);
    expect(screen.queryByRole("button", { name: "以前のメッセージ" })).not.toBeInTheDocument();
  });
  it.each(["unknown", "demo-3"])("shows the same unavailable view for %s", async (id) => {
    setup(id); expect(await screen.findByRole("heading", { name: "この会話は表示できません" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument(); expect(screen.getByRole("link")).toHaveAttribute("href", "/talk");
  });
  it("keeps the composer and explains an unsuccessful send", async () => {
    const real = createChatDemo(() => createDemoLikes());
    setup(undefined, { ...real, sendMessage: async () => ({ code: "rate_limited", data: null }) });
    const body = await screen.findByLabelText("メッセージ"); fireEvent.change(body, { target: { value: "retry later" } });
    fireEvent.click(screen.getByRole("button", { name: "送信" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("しばらく")); expect(body).toHaveValue("retry later"); expect(body).toHaveFocus();
  });
});
