import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TalkList } from "@/components/talk-list";
import { DemoLikesProvider } from "@/components/demo-likes-provider";
import { DemoChatProvider } from "@/components/demo-chat-provider";
import { createDemoLikes } from "@/data/demo-likes";
import { createChatDemo } from "@/lib/chat-demo";
import { CHAT_NOTICE } from "@/lib/chat-gateway";

describe("talk list", () => {
  it("sorts activity, labels unread messages, and links plain paths", async () => {
    const state = createDemoLikes(); state.connections.push(["demo-viewer", "demo-2"]);
    const gateway = createChatDemo(() => state);
    await gateway.sendMessage("demo-2", "test", "latest preview");
    render(<DemoChatProvider gateway={gateway}><TalkList /></DemoChatProvider>);
    expect(await screen.findByText("latest preview")).toBeInTheDocument();
    const links = within(screen.getByRole("main")).getAllByRole("link");
    expect(links[0]).toHaveAttribute("href", "/talk/demo-2");
    expect(screen.getAllByText("未読")).toHaveLength(1);
    expect(screen.getByText(CHAT_NOTICE)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "トーク" })).toHaveAttribute("aria-current", "page");
  });
  it("shows empty connections with the likes link", async () => {
    render(<DemoLikesProvider initialState={{ ...createDemoLikes(), connections: [] }}><DemoChatProvider><TalkList /></DemoChatProvider></DemoLikesProvider>);
    expect(await screen.findByText("つながりはまだありません。")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "いいねを見る" })).toHaveAttribute("href", "/likes");
  });
});
