import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { KeyboardAvoidingView, ScrollView, Text, TextInput, View, type ScrollViewInstance } from "react-native";
import { useAuth } from "../../src/auth-context";
import {
  clientMessageId, latestMessages, loadRoom, markRead, olderMessages, sendChatMessage, type LiveMessage, type MessagePage, type Room,
} from "../../src/chat-data";
import { SafetyControls } from "../../src/dialogs";
import { chatText as text, HIDDEN_CONTENT_TEXT, LOAD_UNAVAILABLE } from "../../src/messages";
import { useMessageFeed } from "../../src/realtime";
import { gateView, useLoad } from "../../src/screen";
import { validateBody } from "../../src/shared";
import { colors, ui } from "../../src/theme";
import { Button } from "../../src/ui";

// The web fixes the zone so its server render and hydration agree; the app shows the same Tokyo time.
const clock = (() => {
  try {
    const format = new Intl.DateTimeFormat("ja-JP", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Tokyo" });
    return (iso: string) => format.format(new Date(iso));
  } catch {
    return (iso: string) => new Date(Date.parse(iso) + 9 * 3_600_000).toISOString().slice(11, 16);
  }
})();
const merge = (a: LiveMessage[], b: LiveMessage[]) => [...new Map([...a, ...b].map((m) => [m.id, m])).values()].sort((x, y) => x.id - y.id);

// MOBILE-003: the web's /talk/[id] (src/app/talk/[id]/page.tsx).
export default function ChatScreen() {
  const { ready, signedIn, services } = useAuth();
  const params = useLocalSearchParams<{ id: string }>();
  const { value } = useLoad((s) => loadRoom(s.supabase, params.id), params.id ?? "");
  const blocked = gateView(ready, signedIn, !!services, value, LOAD_UNAVAILABLE);
  if (blocked) return blocked;
  if (value?.status !== "ok") return null;
  if (!value.room) return <Missing />;
  return <ChatRoom key={value.room.conversation.id} room={value.room} />;
}

function Missing() {
  const router = useRouter();
  return <ScrollView contentContainerStyle={ui.page}>
    <Text testID="chat-missing" style={ui.title} accessibilityRole="header">{text.missing}</Text>
    <Button kind="small" label={text.back} style={{ alignSelf: "flex-start", marginTop: 24 }}
      onPress={() => router.replace("/talk")} />
  </ScrollView>;
}

/**
 * The room of src/components/chat-room-live.tsx: Realtime inserts and the return to the foreground re-read the newest
 * page, which joins the loaded history only after any gap is filled; a block or an ended connection (not_available)
 * closes the room. A failed send keeps its client id, so a retry of the same text cannot post it twice.
 */
function ChatRoom({ room }: { room: Room }) {
  const { services } = useAuth();
  const router = useRouter();
  const id = room.conversation.id;
  const [messages, setMessages] = useState(room.messages);
  const [hasOlder, setHasOlder] = useState(room.hasOlder);
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState("");
  const [available, setAvailable] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const busy = useRef(false), olderBusy = useRef(false), refreshBusy = useRef(false), refreshPending = useRef(false);
  const unavailable = useRef(false), alive = useRef(true);
  const retry = useRef<{ body: string; id: string } | null>(null);
  const history = useRef({ messages: room.messages, hasOlder: room.hasOlder });
  const log = useRef<ScrollViewInstance>(null);
  const scroll = useRef<{ height: number; offset: number } | "bottom" | null>("bottom");
  const contentHeight = useRef(0), offset = useRef(0);
  const client = services?.supabase ?? null;

  function makeUnavailable() { unavailable.current = true; refreshPending.current = false; setAvailable(false); }
  function read(rows: LiveMessage[]) {
    const last = rows.at(-1);
    if (last && !last.mine && client) void markRead(client, id, last.id).catch(() => {});
  }
  useEffect(() => {
    alive.current = true;
    read(room.messages);
    return () => { alive.current = false; };
    // The room's identity is fixed by its key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function acceptNewest(page: MessagePage) {
    if (!client) return;
    const boundary = history.current.messages.at(-1)?.id;
    let rows = page.messages, more = page.hasOlder;
    while (boundary !== undefined && more && rows.length && rows[0].id > boundary) {
      const before = rows[0].id;
      const r = await olderMessages(client, id, before);
      if (!alive.current || unavailable.current) return;
      if (r.status === "not_available") { makeUnavailable(); return; }
      if (r.status !== "ok") throw Error("backfill unavailable");
      if (r.messages.length && r.messages[0].id >= before) throw Error("backfill made no progress");
      rows = merge(rows, r.messages); more = r.hasOlder;
    }
    if (!alive.current || unavailable.current) return;
    const current = history.current;
    history.current = { messages: merge(current.messages, rows), hasOlder: current.messages.length ? current.hasOlder : page.hasOlder };
    setMessages(history.current.messages); setHasOlder(history.current.hasOlder); read(page.messages);
  }
  async function refresh() {
    if (!alive.current || unavailable.current || !client) return;
    if (refreshBusy.current) { refreshPending.current = true; return; }
    refreshBusy.current = true;
    try {
      const r = await latestMessages(client, id);
      if (!alive.current || unavailable.current) return;
      if (r.status === "not_available") makeUnavailable();
      else if (r.status === "ok") { scroll.current = "bottom"; await acceptNewest(r); }
      else setStatus(text.loadFailed);
    } catch {
      if (alive.current && !unavailable.current) setStatus(text.loadFailed);
    } finally {
      refreshBusy.current = false;
      if (refreshPending.current) { refreshPending.current = false; void refresh(); }
    }
  }
  useMessageFeed(client, `chat:${id}`, id, available, () => void refresh());

  async function older() {
    if (olderBusy.current || !messages[0] || !client) return;
    olderBusy.current = true; setLoadingOlder(true);
    try {
      const r = await olderMessages(client, id, messages[0].id);
      if (!alive.current || unavailable.current) return;
      if (r.status === "not_available") makeUnavailable();
      else if (r.status === "ok") {
        scroll.current = { height: contentHeight.current, offset: offset.current };
        history.current = { messages: merge(history.current.messages, r.messages), hasOlder: r.hasOlder };
        setMessages(history.current.messages); setHasOlder(r.hasOlder);
      } else setStatus(text.olderFailed);
    } catch {
      setStatus(text.olderFailed);
    } finally {
      olderBusy.current = false; setLoadingOlder(false);
    }
  }
  async function send() {
    if (busy.current || !available || !validateBody(body) || !client) return;
    busy.current = true; setSending(true);
    const attempt = retry.current?.body === body ? retry.current : { body, id: clientMessageId() };
    retry.current = attempt;
    try {
      const r = await sendChatMessage(client, id, attempt.id, attempt.body);
      if (!alive.current || unavailable.current) return;
      if (r.status === "ok") {
        scroll.current = "bottom";
        await acceptNewest(r);
        if (!alive.current || unavailable.current) return;
        setBody((current) => current === attempt.body ? "" : current);
        retry.current = null;
        setStatus(text.sent);
      } else if (r.status === "not_available") makeUnavailable();
      else {
        if (r.status !== "unavailable") retry.current = null;
        setStatus(r.status === "rate_limited" ? text.rateLimited : text.sendFailed);
      }
    } catch {
      setStatus(text.sendFailed);
    } finally {
      busy.current = false; setSending(false);
    }
  }

  if (!available) return <Missing />;
  const name = room.conversation.partner.name;
  return <KeyboardAvoidingView behavior="padding" style={{ flex: 1, backgroundColor: colors.white }}>
    <View style={{ paddingHorizontal: 16, paddingTop: 40, gap: 8 }}>
      <Button kind="small" label={text.back} style={{ alignSelf: "flex-start" }}
        onPress={() => router.replace("/talk")} />
      <Text testID="chat-name" style={[ui.value, { fontSize: 20, fontWeight: "500" }]} accessibilityRole="header">{name}</Text>
      <View style={ui.rowTight}>
        <SafetyControls kind="conversation" id={id} name={name} block onBlocked={makeUnavailable} />
        <Button testID="chat-check" kind="small" label={text.check} onPress={() => void refresh()} />
      </View>
      {hasOlder ? <Button testID="chat-older" kind="small" label={text.older} disabled={loadingOlder} style={{ alignSelf: "flex-start" }} onPress={() => void older()} /> : null}
    </View>
    <ScrollView ref={log} testID="chat-log" accessibilityLabel="会話履歴" style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 12 }}
      scrollEventThrottle={64} onScroll={(e) => { offset.current = e.nativeEvent.contentOffset.y; }}
      onContentSizeChange={(_w, height) => {
        const pending = scroll.current;
        if (pending === "bottom") log.current?.scrollToEnd({ animated: false });
        else if (pending) log.current?.scrollTo({ y: pending.offset + height - pending.height, animated: false });
        scroll.current = null;
        contentHeight.current = height;
      }}>
      {messages.map((m) => <View key={m.id} testID={`message-${m.id}`} style={[ui.bubble, m.hidden ? ui.bubbleHidden : m.mine ? ui.bubbleMine : ui.bubbleTheirs]}
        accessibilityLabel={`${m.mine ? "自分" : name}：`}>
        {m.hidden ? <Text testID={`message-hidden-${m.id}`} style={[ui.note, { marginTop: 0 }]}>{HIDDEN_CONTENT_TEXT}</Text> :
          <Text selectable style={[ui.body, { color: m.mine ? colors.white : colors.ink }]}>{m.body}</Text>}
        <Text style={[ui.time, { color: m.mine && !m.hidden ? colors.white : colors.muted }]}>{clock(m.createdAt)}</Text>
        {!m.mine && !m.hidden ? <SafetyControls kind="message" id={id} message={{ id: m.id, body: m.body, time: clock(m.createdAt) }} /> : null}
      </View>)}
    </ScrollView>
    <View style={ui.composer}>
      <Text style={ui.label}>{text.label}</Text>
      <TextInput testID="chat-body" multiline value={body} onChangeText={setBody} accessibilityLabel={text.label}
        style={[ui.input, { minHeight: 64, textAlignVertical: "top" }]} />
      <View style={[ui.rowTight, { justifyContent: "space-between", alignItems: "center", marginTop: 8 }]}>
        <Text style={ui.hint}>{[...body].length}{text.count}</Text>
        <Button testID="chat-send" label={text.send} disabled={sending || !validateBody(body)} busy={sending} onPress={() => void send()} />
      </View>
      <Text testID="chat-status" accessibilityLiveRegion="polite" style={[ui.hint, { minHeight: 20 }]}>{status}</Text>
    </View>
  </KeyboardAvoidingView>;
}
