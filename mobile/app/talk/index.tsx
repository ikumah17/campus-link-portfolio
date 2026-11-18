import { useRouter } from "expo-router";
import { useEffect, useMemo } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useAuth } from "../../src/auth-context";
import { loadConversationList } from "../../src/chat-data";
import { LOAD_UNAVAILABLE, talkListText as text } from "../../src/messages";
import { throttle, useMessageFeed } from "../../src/realtime";
import { gateView, MainNav, RemotePhoto, useLoad, usePhotoToken } from "../../src/screen";
import { ui } from "../../src/theme";
import { Button } from "../../src/ui";

// MOBILE-003: the web's /talk (src/components/talk-list-live.tsx, talk-list-realtime.tsx). Any new message of the
// user's re-reads the list, at most once a second; the change's payload is never used.
export default function TalkListScreen() {
  const { ready, signedIn, services } = useAuth();
  const router = useRouter();
  const { value, reload } = useLoad((s) => loadConversationList(s.supabase), "talk");
  const conversations = value?.status === "ok" ? value.conversations : null;
  const token = usePhotoToken(conversations ? conversations.map((c) => c.partner.photoId ?? "").join(",") : "");
  const refresh = useMemo(() => throttle(() => void reload(), 1000), [reload]);
  useEffect(() => refresh.cancel, [refresh]);
  useMessageFeed(services?.supabase ?? null, "talk-list", null, signedIn && conversations !== null, refresh.run);

  const blocked = gateView(ready, signedIn, !!services, value, LOAD_UNAVAILABLE);
  if (blocked) return blocked;
  if (!conversations) return null;

  return <View style={{ flex: 1 }}>
    <ScrollView contentContainerStyle={ui.page}>
      <Text style={ui.title} accessibilityRole="header">{text.title}</Text>
      {conversations.length === 0 ? <View style={{ marginTop: 32, gap: 8, alignItems: "flex-start" }}>
        <Text testID="talk-empty" style={ui.note}>{text.empty}</Text>
        <Button testID="talk-to-likes" kind="small" label={text.toLikes} onPress={() => router.replace("/likes")} />
      </View> : <View style={{ marginTop: 24 }}>
        {conversations.map((row) => <Pressable key={row.id} testID={`talk-row-${row.id}`} accessibilityRole="link" style={ui.talkRow}
          onPress={() => router.push({ pathname: "/talk/[id]", params: { id: row.id } })}>
          <RemotePhoto id={row.partner.photoId} token={token} style={ui.avatar} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={[ui.value, { fontWeight: "500" }]}>{row.partner.name}</Text>
            <Text numberOfLines={1} style={[ui.note, { marginTop: 6 }]}>{row.latest?.body ?? text.noMessage}</Text>
          </View>
          {row.unread ? <Text style={ui.unread}>{text.unread}</Text> : null}
        </Pressable>)}
      </View>}
    </ScrollView>
    <MainNav current="talk" />
  </View>;
}
