import { it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, cleanup } from "@testing-library/react";
import type { ReactElement } from "react";
const m = vi.hoisted(() => ({ create: vi.fn(), auth: vi.fn(), channel: vi.fn(), on: vi.fn(), subscribe: vi.fn(), remove: vi.fn(), refresh: vi.fn(), event: undefined as undefined | ((payload?: unknown) => void), status: undefined as undefined | ((s: string) => void) }));
vi.mock("@/lib/supabase/browser", () => ({ createBrowserSupabase: m.create }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/components/main-nav", () => ({ MainNav: () => null }));
import { TalkListRealtime } from "@/components/talk-list-realtime";
import { TalkListLive } from "@/components/talk-list-live";
const router = { refresh: m.refresh };
const channel = { on: m.on, subscribe: m.subscribe };
let fetchSpy: ReturnType<typeof vi.spyOn>;
const socket = vi.fn(function () { throw Error("no WebSocket"); });
beforeEach(() => {
  vi.clearAllMocks(); vi.useFakeTimers(); vi.setSystemTime(0);
  fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(Error("no network"));
  vi.stubGlobal("WebSocket", socket);
  m.auth.mockResolvedValue(undefined);
  m.create.mockReturnValue({ channel: m.channel, removeChannel: m.remove, realtime: { setAuth: m.auth } });
  m.channel.mockReturnValue(channel);
  m.on.mockImplementation((_type, _options, cb) => { m.event = cb; return channel; });
  m.subscribe.mockImplementation(cb => { m.status = cb; return channel; });
});
afterEach(() => {
  cleanup(); expect(fetchSpy).not.toHaveBeenCalled(); expect(socket).not.toHaveBeenCalled();
  fetchSpy.mockRestore(); vi.unstubAllGlobals(); vi.useRealTimers();
});
function event(payload?: unknown) { act(() => m.event!(payload)); }
function status(value: string) { act(() => m.status!(value)); }
function advance(ms: number) { act(() => vi.advanceTimersByTime(ms)); }
async function view(element: ReactElement = <TalkListRealtime />) {
  let result!: ReturnType<typeof render>;
  await act(async () => { result = render(element); });
  return result;
}
it("subscribes exactly once without a filter and ignores every payload field", async () => {
  const { container } = await view();
  expect(m.channel).toHaveBeenCalledExactlyOnceWith("talk-list");
  expect(m.on).toHaveBeenCalledExactlyOnceWith("postgres_changes", { event: "INSERT", schema: "public", table: "messages" }, expect.any(Function));
  const payload = new Proxy({ sender_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", body: "PAYLOAD SECRET" }, { get() { throw Error("payload read"); }, ownKeys() { throw Error("payload enumeration"); } });
  event(payload);
  expect(m.refresh).toHaveBeenCalledExactlyOnceWith();
  expect(container).toBeEmptyDOMElement();
  expect(document.body).not.toHaveTextContent("PAYLOAD SECRET");
  expect(document.body).not.toHaveTextContent("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
});
it("refreshes a single signal immediately without a trailing refresh", async () => {
  await view(); event(); advance(2000);
  expect(m.refresh).toHaveBeenCalledExactlyOnceWith();
});
it("coalesces a burst with one timer and refreshes immediately after the window", async () => {
  await view(); event(); advance(200); event(); advance(200); event();
  expect(m.refresh).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(1);
  advance(599); expect(m.refresh).toHaveBeenCalledTimes(1);
  advance(1); expect(m.refresh).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
  advance(1001); event(); expect(m.refresh).toHaveBeenCalledTimes(3);
});
it.each(["CHANNEL_ERROR", "TIMED_OUT", "CLOSED"])("catches up once after %s", async failure => {
  await view(); status("SUBSCRIBED"); expect(m.refresh).not.toHaveBeenCalled();
  status(failure); status("SUBSCRIBED"); status("SUBSCRIBED");
  expect(m.refresh).toHaveBeenCalledExactlyOnceWith();
});
it("coalesces reconnects with message signals", async () => {
  await view(); event(); advance(200);
  status("CHANNEL_ERROR"); status("SUBSCRIBED"); event();
  expect(vi.getTimerCount()).toBe(1); advance(800); expect(m.refresh).toHaveBeenCalledTimes(2);
});
it("removes the channel, cancels the timer and ignores late callbacks", async () => {
  const rendered = await view(); event(); event();
  expect(vi.getTimerCount()).toBe(1); rendered.unmount();
  expect(m.remove).toHaveBeenCalledExactlyOnceWith(channel); expect(vi.getTimerCount()).toBe(0);
  event(); status("CHANNEL_ERROR"); status("SUBSCRIBED"); advance(2000);
  expect(m.refresh).toHaveBeenCalledTimes(1);
});
it("silently renders nothing when browser client creation throws", async () => {
  m.create.mockImplementation(() => { throw Error("missing config"); });
  const { container } = await view();
  expect(container).toBeEmptyDOMElement(); expect(m.channel).not.toHaveBeenCalled();
});
it.each([false, true])("mounts realtime once for the live list, populated=%s, preserving its output", async populated => {
  await view(<TalkListLive conversations={populated ? [{ id: "conversation", partner: { name: "Partner", photoId: "photo" }, latest: { body: "hello", at: "now", mine: false }, unread: true }] : []} />);
  expect(m.channel).toHaveBeenCalledExactlyOnceWith("talk-list");
  expect(screen.getByRole("heading", { name: "トーク" })).toBeInTheDocument();
  if (populated) {
    expect(screen.getByText("hello")).toBeInTheDocument(); expect(screen.getByText("未読")).toBeInTheDocument();
    expect(screen.getByRole("link")).toHaveAttribute("href", "/talk/conversation");
  } else {
    expect(screen.getByText("つながりはまだありません。")).toBeInTheDocument();
    expect(screen.getByRole("link")).toHaveAttribute("href", "/likes");
  }
  event(); expect(m.refresh).toHaveBeenCalledExactlyOnceWith();
});
it("waits for authentication before creating or subscribing to the list channel", async () => {
  let finish!: () => void;
  m.auth.mockReturnValueOnce(new Promise<void>(resolve => { finish = resolve; }));
  render(<TalkListRealtime />);
  expect(m.auth).toHaveBeenCalledExactlyOnceWith();
  expect(m.channel).not.toHaveBeenCalled(); expect(m.subscribe).not.toHaveBeenCalled();
  await act(async () => finish());
  expect(m.channel).toHaveBeenCalledExactlyOnceWith("talk-list"); expect(m.subscribe).toHaveBeenCalledTimes(1);
});
it("silently omits Realtime if authentication rejects", async () => {
  m.auth.mockRejectedValueOnce(Error("private auth failure"));
  const { container } = await view();
  expect(container).toBeEmptyDOMElement(); expect(m.channel).not.toHaveBeenCalled(); expect(m.subscribe).not.toHaveBeenCalled();
  expect(m.refresh).not.toHaveBeenCalled();
});
it("never creates a channel if unmounted before authentication resolves", async () => {
  let finish!: () => void;
  m.auth.mockReturnValueOnce(new Promise<void>(resolve => { finish = resolve; }));
  const rendered = render(<TalkListRealtime />); rendered.unmount();
  await act(async () => finish());
  expect(m.channel).not.toHaveBeenCalled(); expect(m.subscribe).not.toHaveBeenCalled(); expect(m.remove).not.toHaveBeenCalled();
  expect(m.refresh).not.toHaveBeenCalled();
});
