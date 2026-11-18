import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useState } from "react";
import { describe, expect, it } from "vitest";
import { DemoLikesProvider } from "@/components/demo-likes-provider";
import { DemoChatProvider } from "@/components/demo-chat-provider";
import { DemoSafetyProvider, useSafetyGateway } from "@/components/demo-safety-provider";
import { BlocksSettings } from "@/components/blocks-settings";
import { useDemoLikes } from "@/components/demo-likes-provider";

function Seed() {
  const gateway = useSafetyGateway(); const [ready, setReady] = useState(false);
  const { state } = useDemoLikes();
  useEffect(() => { void (async () => {
    await gateway!.blockUser("demo-4"); await gateway!.blockUser("unknown");
    await gateway!.submitReport({ target: "demo-1", context: "profile", reason: "other", detail: "private detail" });
    setReady(true);
  })(); }, [gateway]);
  return ready && <><BlocksSettings /><output aria-label="connection count">{state.connections.length}</output></>;
}
describe("blocks settings", () => {
  it("uses snapshots and minimal history, confirms unblock and never restores connections", async () => {
    const user = userEvent.setup({ delay: null });
    render(<DemoLikesProvider><DemoChatProvider><DemoSafetyProvider><Seed /></DemoSafetyProvider></DemoChatProvider></DemoLikesProvider>);
    expect(await screen.findByText("ゆう（架空）")).toBeInTheDocument();
    expect(screen.getByText("表示できないユーザー")).toBeInTheDocument();
    expect(await screen.findByText("report-1")).toBeInTheDocument();
    expect(screen.queryByText("private detail")).not.toBeInTheDocument();
    const trigger = screen.getAllByRole("button", { name: "ブロック解除" })[0];
    await user.click(trigger);
    let dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/元に戻りません/)).toBeInTheDocument();
    const confirm = within(dialog).getByRole("button", { name: "ブロック解除" });
    expect(confirm).toHaveFocus(); await user.tab({ shift: true }); expect(within(dialog).getByRole("button", { name: "キャンセル" })).toHaveFocus();
    await user.keyboard("{Escape}"); await waitFor(() => expect(trigger).toHaveFocus());
    await user.click(trigger); dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "ブロック解除" }));
    expect(within(dialog).getByRole("status")).toHaveTextContent("ブロックを解除しました");
    await user.click(within(dialog).getByRole("button", { name: "閉じる" }));
    await waitFor(() => expect(screen.queryByText("ゆう（架空）")).not.toBeInTheDocument());
    expect(screen.getByLabelText("connection count")).toHaveTextContent("0");
  });
});
