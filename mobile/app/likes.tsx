import { useRouter } from "expo-router";
import { useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useAuth } from "../src/auth-context";
import { SafetyControls } from "../src/dialogs";
import { listLikes, likeUser, loadLikes, unlikeUser, type LikeAnswer, type LikeCursor, type LiveLike } from "../src/like-data";
import { likeMessages, likesText as text, likeText, LIKES_MORE, LOAD_UNAVAILABLE } from "../src/messages";
import { gateView, MainNav, RemotePhoto, useLoad, usePhotoToken } from "../src/screen";
import { purposeText } from "../src/shared";
import { ui } from "../src/theme";
import { Button } from "../src/ui";

type Tab = 0 | 1;
const DIRECTIONS = ["received", "sent"] as const;

// MOBILE-LIKES-001: the web's /likes (src/components/likes-view.tsx and likes-live.tsx, docs/43 §4.1). The received
// list (the default) offers "like back", the sent list offers "take back"; a row that succeeded leaves its list, and a
// match offers the talk. "More" adds the next page (keyset) of the shown list. Each row keeps block and report in the
// profile context; a blocked person leaves both lists, as the database removes the likes both ways.
export default function LikesScreen() {
  const { ready, signedIn, services } = useAuth();
  const router = useRouter();
  const { value } = useLoad((s) => loadLikes(s.supabase), "likes");
  const [tab, setTab] = useState<Tab>(0);
  const [status, setStatus] = useState("");
  // The conversation to open after a match; null opens the talk list (already_connected), undefined shows no button.
  const [talk, setTalk] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [gone, setGone] = useState<Set<string>>(new Set());
  // Pages added by "more", per list, with the cursor of the last one (undefined: still the first page's).
  const [more, setMore] = useState<[LiveLike[], LiveLike[]]>([[], []]);
  const [next, setNext] = useState<[LikeCursor | null | undefined, LikeCursor | null | undefined]>([undefined, undefined]);
  const [moreFailed, setMoreFailed] = useState(false);
  const running = useRef(new Set<string>());
  const loadingMore = useRef(false);
  const lists = value?.status === "ok" ? value : null;
  const all: [LiveLike[], LiveLike[]] = lists ? [[...lists.received.likes, ...more[0]], [...lists.sent.likes, ...more[1]]] : [[], []];
  const token = usePhotoToken([...all[0], ...all[1]].map((r) => r.profile.photoIds[0] ?? "").join(","));

  const blocked = gateView(ready, signedIn, !!services, value, LOAD_UNAVAILABLE, text.title);
  if (blocked) return blocked;
  if (!lists || !services) return null;
  const firstPages = [lists.received, lists.sent] as const;
  const cursor = (i: Tab) => next[i] === undefined ? firstPages[i].next : next[i];

  async function act(row: LiveLike, kind: "back" | "unlike") {
    if (running.current.has(row.id) || !services) return;
    running.current.add(row.id); setBusy(new Set(running.current)); setTalk(undefined);
    let answer: LikeAnswer;
    try { answer = await (kind === "back" ? likeUser : unlikeUser)(services.supabase, row.id); } catch { answer = { status: "unavailable" }; }
    if (answer.status === "ok") {
      setGone((g) => new Set(g).add(`${kind}:${row.id}`));
      if (kind === "unlike") setStatus(likeText.unliked);
      else if (answer.conversationId) { setStatus(likeText.matched); setTalk(answer.conversationId); }
      else setStatus(likeText.liked);
    } else {
      setStatus(likeMessages[answer.status]);
      if (answer.status === "already_connected") setTalk(null);
    }
    running.current.delete(row.id); setBusy(new Set(running.current));
  }
  async function loadMore(i: Tab) {
    const after = cursor(i);
    if (loadingMore.current || !after || !services) return;
    loadingMore.current = true; setMoreFailed(false);
    const page = await listLikes(services.supabase, DIRECTIONS[i], after).catch(() => ({ status: "unavailable" as const }));
    if (page.status === "ok") {
      setMore((m) => i === 0 ? [[...m[0], ...page.likes], m[1]] : [m[0], [...m[1], ...page.likes]]);
      setNext((n) => i === 0 ? [page.next, n[1]] : [n[0], page.next]);
    } else setMoreFailed(true);
    loadingMore.current = false;
  }
  const openTalk = () => talk ? router.push({ pathname: "/talk/[id]", params: { id: talk } }) : router.replace("/talk");

  const kind = tab === 0 ? "back" : "unlike";
  const rows = all[tab].filter((r) => !gone.has(`${kind}:${r.id}`));
  return <View style={{ flex: 1 }}>
    <ScrollView contentContainerStyle={ui.page}>
      <Text style={ui.title} accessibilityRole="header">{text.title}</Text>
      <Text style={[ui.note, { fontSize: 15, lineHeight: 26 }]}>{text.description}</Text>
      <View accessibilityRole="tablist" accessibilityLabel={text.tabList} style={ui.segment}>
        {text.tabs.map((label, i) => <Pressable key={label} testID={`likes-tab-${i}`} accessibilityRole="tab" accessibilityState={{ selected: tab === i }}
          style={[ui.segmentItem, tab === i && ui.segmentCurrent]} onPress={() => { setTab(i as Tab); setMoreFailed(false); }}>
          <Text style={[ui.value, tab === i && { fontWeight: "500" }]}>{label}</Text>
        </Pressable>)}
      </View>
      <Text testID="likes-status" accessibilityLiveRegion="polite" style={[ui.message, { marginVertical: 20, minHeight: 22 }]}>{status}</Text>
      {talk !== undefined ? <Button testID="likes-open-talk" label={likeText.openTalk} style={{ marginBottom: 20 }} onPress={openTalk} /> : null}
      <View style={{ gap: 16 }}>
        {rows.map((r) => <View key={r.id} testID="like-item" style={[ui.outlined, { marginTop: 0 }]}>
          <Pressable testID={`like-profile-${r.id}`} accessibilityRole="link" style={{ flexDirection: "row", alignItems: "center", gap: 16 }}
            onPress={() => router.push({ pathname: "/profiles/[id]", params: { id: r.id } })}>
            <RemotePhoto id={r.profile.photoIds[0]} token={token} label={`${r.profile.name}の写真`} style={ui.avatar} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={[ui.value, { fontSize: 18, fontWeight: "500" }]}>{r.profile.name} <Text style={ui.age}>{r.profile.age}{text.age}</Text></Text>
              <Text style={[ui.note, { marginTop: 4 }]}>{r.profile.school}</Text>
              {r.profile.purposes.length ? <Text testID={`like-purposes-${r.id}`} style={[ui.note, { marginTop: 4 }]}>{purposeText(r.profile.purposes)}</Text> : null}
            </View>
          </Pressable>
          <View style={[ui.rowTight, { alignItems: "center" }]}>
            {tab === 0 ? <Button testID={`like-back-${r.id}`} label={likeText.likeBack} accessibilityLabel={`${r.profile.name}${likeText.likeBackLabel}`}
              disabled={busy.has(r.id)} onPress={() => void act(r, "back")} />
              : <Button testID={`like-unlike-${r.id}`} kind="secondary" label={likeText.unlike} accessibilityLabel={`${r.profile.name}${likeText.unlikeLabel}`}
                disabled={busy.has(r.id)} onPress={() => void act(r, "unlike")} />}
          </View>
          <SafetyControls kind="profile" id={r.id} name={r.profile.name} block
            onBlocked={() => setGone((g) => new Set(g).add(`back:${r.id}`).add(`unlike:${r.id}`))} />
        </View>)}
      </View>
      {!rows.length ? tab === 0 ? <Text testID="likes-empty" style={ui.note}>{text.emptyReceived}</Text>
        : <View style={{ gap: 8, alignItems: "flex-start" }}>
          <Text testID="likes-empty" style={ui.note}>{text.emptySent}</Text>
          <Button testID="likes-to-discover" kind="small" label={text.toDiscover} onPress={() => router.replace("/discover")} />
        </View> : null}
      {cursor(tab) ? <Button testID="likes-more" kind="secondary" label={LIKES_MORE} style={{ marginTop: 24 }} onPress={() => void loadMore(tab)} /> : null}
      {moreFailed ? <Text testID="likes-more-failed" style={ui.message} accessibilityRole="alert">{LOAD_UNAVAILABLE}</Text> : null}
    </ScrollView>
    <MainNav current="likes" />
  </View>;
}
