import { render } from "@testing-library/react-native";
import { act } from "react";
import { AppState } from "react-native";
import { throttle, useMessageFeed, watchMessages, type RealtimeClient } from "../src/realtime";

// MOBILE-003: the Realtime subscribe, unsubscribe and refresh logic, with a mocked supabase-js client.
function fakeRealtime(options: { setAuthFails?: boolean } = {}) {
  const channels: { name: string; filter: Record<string, unknown>; insert: () => void; status: (value: string) => void }[] = [];
  let pendingAuth: (() => void) | null = null;
  const setAuth = jest.fn(() => options.setAuthFails ? Promise.reject(new Error("no session")) : new Promise<void>((resolve) => { pendingAuth = resolve; }));
  const removeChannel = jest.fn(async () => "ok");
  const channel = jest.fn((name: string) => {
    const record = { name, filter: {}, insert: () => {}, status: (_value: string) => {} };
    const builder = {
      on: (_type: string, filter: Record<string, unknown>, callback: () => void) => { record.filter = filter; record.insert = callback; return builder; },
      subscribe: (callback: (value: string) => void) => { record.status = callback; channels.push(record); return builder; },
    };
    return builder;
  });
  const client = { realtime: { setAuth }, channel, removeChannel } as unknown as RealtimeClient;
  return { client, channels, setAuth, removeChannel, channel, authorize: async () => { await act(async () => { pendingAuth?.(); await Promise.resolve(); }); } };
}

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

describe("watchMessages", () => {
  it("loads the session's token before joining, then refreshes on each insert", async () => {
    const fake = fakeRealtime();
    const onChange = jest.fn();
    watchMessages(fake.client, "chat:room", "room-id", onChange);
    expect(fake.setAuth).toHaveBeenCalledWith();
    expect(fake.channel).not.toHaveBeenCalled();
    await fake.authorize();
    expect(fake.channels[0]).toMatchObject({ name: "chat:room", filter: { event: "INSERT", schema: "public", table: "messages", filter: "conversation_id=eq.room-id" } });
    fake.channels[0].insert();
    fake.channels[0].insert();
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("watches all of the user's messages without a filter for the talk list", async () => {
    const fake = fakeRealtime();
    watchMessages(fake.client, "talk-list", null, jest.fn());
    await fake.authorize();
    expect(fake.channels[0].filter).toEqual({ event: "INSERT", schema: "public", table: "messages" });
  });

  it("refreshes once after a rejoin that followed an error, not on the first join", async () => {
    const fake = fakeRealtime();
    const onChange = jest.fn();
    watchMessages(fake.client, "talk-list", null, onChange);
    await fake.authorize();
    const { status } = fake.channels[0];
    status("SUBSCRIBED");
    expect(onChange).not.toHaveBeenCalled();
    for (const failure of ["CHANNEL_ERROR", "TIMED_OUT", "CLOSED"]) {
      status(failure);
      status("SUBSCRIBED");
      status("SUBSCRIBED");
    }
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it("removes the channel on unsubscribe and ignores anything after it", async () => {
    const fake = fakeRealtime();
    const onChange = jest.fn();
    const stop = watchMessages(fake.client, "chat:room", "room-id", onChange);
    await fake.authorize();
    stop();
    expect(fake.removeChannel).toHaveBeenCalledTimes(1);
    fake.channels[0].insert();
    fake.channels[0].status("CHANNEL_ERROR");
    fake.channels[0].status("SUBSCRIBED");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("never joins when unsubscribed before the token loaded", async () => {
    const fake = fakeRealtime();
    const stop = watchMessages(fake.client, "chat:room", "room-id", jest.fn());
    stop();
    await fake.authorize();
    expect(fake.channel).not.toHaveBeenCalled();
    expect(fake.removeChannel).not.toHaveBeenCalled();
  });

  it("does not join without a session", async () => {
    const fake = fakeRealtime({ setAuthFails: true });
    watchMessages(fake.client, "talk-list", null, jest.fn());
    await flush();
    expect(fake.channel).not.toHaveBeenCalled();
  });
});

describe("throttle", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("runs at once, then folds a burst into one call at the end of the interval", () => {
    let now = 0;
    const callback = jest.fn();
    const limited = throttle(callback, 1000, () => now);
    limited.run();
    expect(callback).toHaveBeenCalledTimes(1);
    now = 200; limited.run();
    now = 400; limited.run();
    expect(callback).toHaveBeenCalledTimes(1);
    now = 1000; jest.advanceTimersByTime(800);
    expect(callback).toHaveBeenCalledTimes(2);
    now = 2500; limited.run();
    expect(callback).toHaveBeenCalledTimes(3);
  });

  it("drops a pending call on cancel", () => {
    let now = 0;
    const callback = jest.fn();
    const limited = throttle(callback, 1000, () => now);
    limited.run();
    now = 100; limited.run();
    limited.cancel();
    jest.advanceTimersByTime(2000);
    expect(callback).toHaveBeenCalledTimes(1);
  });
});

describe("useMessageFeed", () => {
  function Feed({ client, enabled, onChange }: { client: RealtimeClient; enabled: boolean; onChange: () => void }) {
    useMessageFeed(client, "chat:room", "room-id", enabled, onChange);
    return null;
  }

  it("subscribes while enabled, refreshes on the return to the foreground, and cleans up", async () => {
    const listeners: ((state: string) => void)[] = [];
    const remove = jest.fn();
    const spy = jest.spyOn(AppState, "addEventListener").mockImplementation(((_type: string, listener: (state: string) => void) => {
      listeners.push(listener);
      return { remove };
    }) as unknown as typeof AppState.addEventListener);
    const fake = fakeRealtime();
    const first = jest.fn(), second = jest.fn();
    const view = await render(<Feed client={fake.client} enabled onChange={first} />);
    await fake.authorize();
    expect(fake.channel).toHaveBeenCalledTimes(1);
    // A new callback is used without rejoining.
    await view.rerender(<Feed client={fake.client} enabled onChange={second} />);
    expect(fake.channel).toHaveBeenCalledTimes(1);
    fake.channels[0].insert();
    expect(second).toHaveBeenCalledTimes(1);
    act(() => { listeners[0]("background"); listeners[0]("active"); });
    expect(second).toHaveBeenCalledTimes(2);
    expect(first).not.toHaveBeenCalled();
    await view.rerender(<Feed client={fake.client} enabled={false} onChange={second} />);
    expect(fake.removeChannel).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("does nothing while disabled", async () => {
    const fake = fakeRealtime();
    await render(<Feed client={fake.client} enabled={false} onChange={jest.fn()} />);
    expect(fake.setAuth).not.toHaveBeenCalled();
  });
});
