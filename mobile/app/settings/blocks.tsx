import { useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useAuth } from "../../src/auth-context";
import { Dialog } from "../../src/dialogs";
import { blocksText as text, LOAD_UNAVAILABLE, safetyMessages, safetyText, unblockText } from "../../src/messages";
import { gateView, useLoad } from "../../src/screen";
import { loadBlocks, unblock, type BlockRow } from "../../src/settings-data";
import { colors, ui } from "../../src/theme";
import { Button } from "../../src/ui";

// The web's fixed zone, so a date reads the same on both.
const day = new Intl.DateTimeFormat("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "Asia/Tokyo" });

/** "ブロックを解除" and its dialog (the web's SafetyControlsLive with unblock). The row leaves the list when it closes. */
function UnblockControl({ row, index, onDone }: { row: BlockRow; index: number; onDone: () => void }) {
  const { services } = useAuth();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState("");
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  async function submit() {
    if (running.current || done || !services) return;
    running.current = true; setBusy(true);
    const result = await unblock(services.supabase, row.target).catch(() => "unavailable" as const);
    if (result === "ok") { setDone(true); setStatus(unblockText.done); } else setStatus(safetyMessages[result]);
    running.current = false; setBusy(false);
  }
  function close() {
    if (running.current) return;
    setOpen(false);
    if (done) onDone();
  }
  return <>
    <Button testID={`unblock-${index}`} kind="small" label={unblockText.open} style={{ alignSelf: "flex-start" }}
      onPress={() => { setStatus(""); setDone(false); setOpen(true); }} />
    {open ? <Dialog testID="unblock-dialog" title={unblockText.title} onClose={close}>
      <Text style={ui.body}>{unblockText.note}</Text>
      {!done ? <Button testID="unblock-submit" label={unblockText.open} disabled={busy} busy={busy} onPress={() => void submit()} /> : null}
      <Text testID="unblock-status" accessibilityLiveRegion="polite" style={ui.message}>{status}</Text>
      <Pressable testID="unblock-close" accessibilityRole="button" disabled={busy} onPress={close} style={[ui.secondaryButton, busy && ui.disabled]}>
        <Text style={ui.secondaryButtonText}>{done ? safetyText.close : safetyText.cancel}</Text>
      </Pressable>
    </Dialog> : null}
  </>;
}

// MOBILE-004: the web's /settings/blocks (src/components/blocks-settings-live.tsx): list_my_blocks with unblock_user,
// and the states of the own reports (my_reports). A blocked user's id is used only to unblock, never shown.
export default function BlocksScreen() {
  const { ready, signedIn, services } = useAuth();
  const router = useRouter();
  const { value } = useLoad((s) => loadBlocks(s.supabase), "blocks");
  const page = value?.status === "ok" ? value : null;
  const [blocks, setBlocks] = useState<BlockRow[]>([]);
  useEffect(() => { if (page) setBlocks(page.blocks); }, [page]);

  const blocked = gateView(ready, signedIn, !!services, value, LOAD_UNAVAILABLE, text.title);
  if (blocked) return blocked;
  if (!page) return <View style={ui.page} />;

  return <ScrollView contentContainerStyle={ui.page}>
    <Button kind="small" label={text.back} style={{ alignSelf: "flex-start" }}
      onPress={() => { if (router.canGoBack()) router.back(); else router.replace("/mypage"); }} />
    <Text style={[ui.title, { marginTop: 16 }]} accessibilityRole="header">{text.title}</Text>
    {blocks.length === 0 ? <Text testID="blocks-empty" style={[ui.note, { marginTop: 24 }]}>{text.empty}</Text> :
      <View style={{ marginTop: 24 }}>{blocks.map((b, index) => <View key={b.target} testID={`block-${index}`}
        style={{ paddingVertical: 16, gap: 8, borderBottomWidth: 1, borderColor: colors.line }}>
        <Text style={ui.value}>{b.name ?? text.unknown}</Text>
        <Text style={ui.term}>{day.format(new Date(b.createdAt))}</Text>
        <UnblockControl row={b} index={index} onDone={() => setBlocks((rows) => rows.filter((row) => row.target !== b.target))} />
      </View>)}</View>}
    <View style={{ marginTop: 40, gap: 12 }} accessibilityLabel={text.reports}>
      <Text style={[ui.sectionTitle, { fontSize: 17 }]} accessibilityRole="header">{text.reports}</Text>
      {page.reports.length === 0 ? <Text testID="reports-empty" style={ui.note}>{text.noReports}</Text> :
        page.reports.map((r, index) => <Text key={index} testID={`report-${index}`} style={ui.message}>
          {day.format(new Date(r.createdAt))} · {text.labels[r.status]}
        </Text>)}
    </View>
  </ScrollView>;
}
