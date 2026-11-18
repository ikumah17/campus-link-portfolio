import { describe, expect, it } from "vitest";
import { createSafetyDemo } from "@/lib/safety-demo";
import { createChatDemo } from "@/lib/chat-demo";
import { createDemoLikes, demoViewer } from "@/data/demo-likes";
import { likesReducer, like } from "@/lib/likes-demo";
import { validateReport, type ReportInput } from "@/lib/safety-gateway";

function setup() {
  let state = createDemoLikes();
  const chat = createChatDemo(() => state);
  const gateway = createSafetyDemo(() => state, (a) => { state = likesReducer(state, a); }, chat);
  return { gateway, chat, state: () => state };
}
const report: ReportInput = { target: "demo-1", context: "profile", reason: "other", detail: "" };
describe("safety gateway", () => {
  it("rejects self block without effects and returns identical results for all targets", async () => {
    const { gateway, state } = setup();
    expect(await gateway.blockUser(demoViewer)).toEqual({ code: "validation", data: null });
    expect(state().blocks).toBeUndefined();
    const visible = await gateway.blockUser("demo-1");
    expect(await gateway.blockUser("demo-4")).toEqual(visible);
    expect(await gateway.blockUser("unknown")).toEqual(visible);
    expect(await gateway.blockUser("invisible")).toEqual(visible);
    expect(await gateway.blockUser("demo-1")).toEqual(visible);
    const rows = (await gateway.listMyBlocks()).data;
    expect(rows).toHaveLength(4);
    expect(rows[0].blocked_name_snapshot).toBeTruthy();
    expect(rows[2].blocked_name_snapshot).toBeNull();
    expect(rows[3].blocked_name_snapshot).toBeNull();
    expect(Object.keys(rows[0]).sort()).toEqual(["blocked_id", "blocked_name_snapshot", "created_at"]);
    rows[0].blocked_name_snapshot = "changed DTO";
    expect((await gateway.listMyBlocks()).data[0].blocked_name_snapshot).not.toBe("changed DTO");
  });
  it("removes likes both ways, blocks active connections and never restores them", async () => {
    const { gateway, chat, state } = setup();
    await gateway.blockUser("demo-2");
    expect(state().likes).toEqual([]);
    expect(like(state(), demoViewer, "demo-2").code).toBe("not_available");
    await gateway.blockUser("demo-4");
    expect(state().endedConnections).toEqual([{ members: [demoViewer, "demo-4"], reason: "blocked" }]);
    expect((await chat.listMyConversations()).data).toEqual([]);
    expect((await chat.sendMessage("demo-4", "x", "test")).code).toBe("not_available");
    expect((await gateway.unblockUser("demo-4")).code).toBe("ok");
    expect((await gateway.unblockUser("unknown")).code).toBe("ok");
    expect(state().connections).toEqual([]);
    expect((await chat.listMyConversations()).data).toEqual([]);
    await gateway.unblockUser("demo-2");
    expect(state().likes).toEqual([]);
    const again = like(state(), demoViewer, "demo-2");
    expect(again.code).toBe("ok"); expect(again.conversationId).toBeUndefined();
  });
  it.each([0, 1000, 1001])("validates %i Unicode code points", async (length) => {
    const { gateway } = setup();
    expect((await gateway.submitReport({ ...report, detail: "😀".repeat(length) })).code).toBe(length <= 1000 ? "ok" : "validation");
  });
  it("rejects unknown reasons, contexts (a request is no longer one) and missing context ids before relation checks", async () => {
    const { gateway } = setup();
    for (const patch of [{ reason: "constructor" }, { context: "unknown" }, { context: "message" }, { context: "request", requestId: "received-1" }]) {
      const input = { ...report, ...patch } as ReportInput;
      expect(validateReport(input)).toBe(false);
      expect((await gateway.submitReport(input)).code).toBe("validation");
    }
    expect((await gateway.submitReport({ ...report, target: "unknown" })).code).toBe("not_available");
    expect((await gateway.submitReport({ ...report, target: demoViewer })).code).toBe("not_available");
  });
  it("accepts only the partner's message, and a profile report from someone who liked the viewer", async () => {
    const { gateway } = setup();
    expect((await gateway.submitReport({ ...report, target: "demo-4", context: "message", messageId: 36 })).code).toBe("ok");
    for (const messageId of [35, 999]) expect((await gateway.submitReport({ ...report, target: "demo-4", context: "message", messageId })).code).toBe("not_available");
    expect((await gateway.submitReport({ ...report, context: "message", messageId: 36 })).code).toBe("not_available");
    expect((await gateway.submitReport({ ...report, target: "demo-2" })).code).toBe("ok");
    const rows = (await gateway.myReports()).data;
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(Object.keys(row).sort()).toEqual(["created_at", "id", "status"]);
  });
  it("retains an ended connection relation for profile reports", async () => {
    const { gateway } = setup();
    await gateway.blockUser("demo-4");
    await gateway.unblockUser("demo-4");
    expect((await gateway.submitReport({ ...report, target: "demo-4" })).code).toBe("ok");
  });
});
