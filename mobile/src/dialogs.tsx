import { useRouter } from "expo-router";
import { useRef, useState, type ReactNode } from "react";
import { Modal, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAuth } from "./auth-context";
import { likeUser, unlikeUser, type LikeAnswer, type LikeState } from "./like-data";
import { likeMessages, likeText, safetyMessages, safetyText as text } from "./messages";
import { blockConversation, blockProfile, report, type ReportKind, type SafetyStatus } from "./safety-data";
import { reportReasons, type ReportReason } from "./shared";
import { ui } from "./theme";
import { Button, Choice } from "./ui";

// MOBILE-003: the web's block and report controls (src/components/safety-controls-live.tsx) as native modals. A dialog
// cannot be closed while its request is running. MOBILE-LIKES-001: the like buttons (src/components/like-controls.tsx)
// replace the request dialog.
export function Dialog({ title, onClose, children, testID }: { title: string; onClose: () => void; children: ReactNode; testID?: string }) {
  // FIX-005: a modal covers the whole screen, so its dialog keeps clear of the safe-area insets itself.
  const insets = useSafeAreaInsets();
  return <Modal transparent animationType="fade" visible onRequestClose={onClose}>
    <View testID={testID ? `${testID}-backdrop` : undefined} style={[ui.backdrop, {
      paddingTop: 16 + insets.top, paddingBottom: 16 + insets.bottom, paddingLeft: 16 + insets.left, paddingRight: 16 + insets.right,
    }]}>
      <View testID={testID} accessibilityViewIsModal style={ui.dialog}>
        <ScrollView contentContainerStyle={{ gap: 16 }} keyboardShouldPersistTaps="handled">
          <Text style={ui.dialogTitle} accessibilityRole="header">{title}</Text>
          {children}
        </ScrollView>
      </View>
    </View>
  </Modal>;
}

const count = (value: string) => [...value].length;

export const NO_LIKE: LikeState = { iLiked: false, likedMe: false, conversationId: null };

/**
 * One person's like state (get_like_state) and its buttons, on the detail page and the discovery cards (docs/43 §4.3,
 * Q8): いいね; いいね済み with 取り消す; あなたにいいねしています with いいねを返す; or トークを開く after a match. One call
 * runs at a time; a match without a known conversation (already_connected) opens the talk list.
 */
export function LikeControls({ id, name, initial = NO_LIKE, testID = "like" }: { id: string; name: string; initial?: LikeState; testID?: string }) {
  const { services } = useAuth();
  const router = useRouter();
  const [state, setState] = useState<LikeState & { matched?: boolean }>(initial);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const running = useRef(false);
  async function run(kind: "like" | "unlike") {
    if (running.current || !services) return;
    running.current = true; setBusy(true);
    let answer: LikeAnswer;
    try { answer = await (kind === "like" ? likeUser : unlikeUser)(services.supabase, id); } catch { answer = { status: "unavailable" }; }
    if (answer.status === "ok") {
      if (kind === "unlike") { setState((s) => ({ ...s, iLiked: false })); setStatus(likeText.unliked); }
      else if (answer.conversationId) { setState({ iLiked: false, likedMe: false, conversationId: answer.conversationId }); setStatus(likeText.matched); }
      else { setState((s) => ({ ...s, iLiked: true })); setStatus(likeText.liked); }
    } else {
      if (answer.status === "already_connected") setState({ iLiked: false, likedMe: false, conversationId: null, matched: true });
      setStatus(likeMessages[answer.status]);
    }
    running.current = false; setBusy(false);
  }
  const conversation = state.conversationId;
  const openTalk = () => conversation ? router.push({ pathname: "/talk/[id]", params: { id: conversation } }) : router.replace("/talk");
  return <View style={{ gap: 8 }}>
    {conversation !== null || state.matched ? <Button testID={`${testID}-talk`} label={likeText.openTalk} onPress={openTalk} />
      : state.iLiked ? <View style={[ui.rowTight, { justifyContent: "space-between", alignItems: "center" }]}>
        <Text testID={`${testID}-liked`} style={ui.value}>{likeText.iLiked}</Text>
        <Button testID={`${testID}-unlike`} kind="small" label={likeText.unlike} accessibilityLabel={`${name}${likeText.unlikeLabel}`} disabled={busy} onPress={() => void run("unlike")} />
      </View>
      : state.likedMe ? <>
        <Text testID={`${testID}-liked-me`} style={ui.value}>{likeText.likedMe}</Text>
        <Button testID={`${testID}-back`} label={likeText.likeBack} accessibilityLabel={`${name}${likeText.likeBackLabel}`} disabled={busy} onPress={() => void run("like")} />
      </>
      : <Button testID={`${testID}-button`} kind="secondary" label={likeText.like} accessibilityLabel={`${name}${likeText.likeLabel}`} disabled={busy} onPress={() => void run("like")} />}
    <Text testID={`${testID}-status`} accessibilityLiveRegion="polite" style={ui.message}>{status}</Text>
  </View>;
}

type SafetyView = "menu" | "block" | "report" | null;

/**
 * Block and report. On a profile both buttons show; on a conversation one "ブロック・通報" button opens a menu; on a
 * counterpart's message only "通報". onBlocked runs after a block, so the screen can close the content.
 */
export function SafetyControls({ kind, id, name, message, block = false, onBlocked }: {
  kind: ReportKind; id: string; name?: string; message?: { id: number; body: string; time: string }; block?: boolean; onBlocked?: () => void;
}) {
  const { services } = useAuth();
  const [dialog, setDialog] = useState<SafetyView>(null);
  const [reason, setReason] = useState<ReportReason>("harassment");
  const [detail, setDetail] = useState("");
  const [status, setStatus] = useState("");
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const tooLong = count(detail) > 1000;

  function open(next: SafetyView) { setStatus(""); setDone(false); setDetail(""); setReason("harassment"); setDialog(next); }
  async function submit() {
    if (running.current || done || !services || (dialog === "report" && tooLong)) return;
    running.current = true; setBusy(true);
    let result: SafetyStatus;
    try {
      result = dialog === "block"
        ? await (kind === "profile" ? blockProfile(services.supabase, id) : blockConversation(services.supabase, id))
        : await report(services.supabase, kind, id, reason, detail, message?.id);
    } catch {
      result = "unavailable";
    }
    if (result === "ok") {
      setDone(true);
      setStatus(dialog === "report" ? text.reported : text.blocked);
      // docs/42 §2.2: no photo of a blocked user stays in the memory cache.
      if (dialog === "block") await Promise.resolve().then(services.clearImages).catch(() => {});
    } else setStatus(safetyMessages[result]);
    running.current = false; setBusy(false);
  }
  function close() {
    if (running.current) return;
    const blocked = dialog === "block" && done;
    setDialog(null);
    if (blocked) onBlocked?.();
  }

  const title = dialog === "menu" ? text.menu : dialog === "report" ? text.report : `${name ?? text.counterpart}${text.blockTitle}`;
  return <>
    <View style={ui.rowTight}>
      {block && kind === "profile" ? <>
        <Button testID="safety-block" kind="small" label={text.block} onPress={() => open("block")} />
        <Button testID="safety-report" kind="small" label={text.report} onPress={() => open("report")} />
      </> : <Button testID={message ? `safety-report-message-${message.id}` : block ? "safety-menu" : "safety-report"} kind="small"
        label={block ? text.menu : text.report} onPress={() => open(block ? "menu" : "report")} />}
    </View>
    {dialog ? <Dialog testID="safety-dialog" title={title} onClose={close}>
      {dialog === "menu" ? <>
        <Button testID="safety-menu-block" kind="secondary" label={text.block} onPress={() => setDialog("block")} />
        <Button testID="safety-menu-report" kind="secondary" label={text.report} onPress={() => setDialog("report")} />
      </> : <>
        {dialog === "block" ? <Text style={ui.body}>{text.blockNote}</Text> : <>
          {message ? <Text style={ui.quote}>{message.body}</Text> : null}
          <View accessibilityRole="radiogroup" accessibilityLabel={text.reason} style={{ gap: 8 }}>
            <Text style={ui.sectionTitle}>{text.reason}</Text>
            {(Object.entries(reportReasons) as [ReportReason, string][]).map(([key, label]) =>
              <Choice key={key} testID={`reason-${key}`} label={label} selected={reason === key} disabled={done || busy} onPress={() => setReason(key)} />)}
          </View>
          <View>
            <Text style={ui.label}>{text.detail}</Text>
            <TextInput testID="report-detail" multiline value={detail} editable={!done && !busy} onChangeText={setDetail} accessibilityLabel={text.detail}
              style={[ui.input, { minHeight: 96, textAlignVertical: "top" }]} />
            <Text style={[ui.hint, { textAlign: "right" }]}>{count(detail)}{text.count}</Text>
          </View>
        </>}
        {!done ? <Button testID="safety-submit" label={dialog === "report" ? text.submitReport : text.submitBlock}
          disabled={busy || (dialog === "report" && tooLong)} busy={busy} onPress={() => void submit()} /> : null}
        <Text testID="safety-status" accessibilityLiveRegion="polite" style={ui.message}>{status}</Text>
      </>}
      <Pressable accessibilityRole="button" disabled={busy} onPress={close} style={[ui.secondaryButton, busy && ui.disabled]}>
        <Text style={ui.secondaryButtonText}>{done ? text.close : text.cancel}</Text>
      </Pressable>
    </Dialog> : null}
  </>;
}
