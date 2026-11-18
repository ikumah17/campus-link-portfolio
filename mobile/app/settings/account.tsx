import { useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ScrollView, Text, TextInput, View } from "react-native";
import { useAuth } from "../../src/auth-context";
import { Dialog } from "../../src/dialogs";
import { accountMessages, accountText as text, DELETE_CONFIRMATION, LOAD_UNAVAILABLE, PAUSE_NOTE } from "../../src/messages";
import { gateView, useLoad } from "../../src/screen";
import { loadAccount, pauseAccount, requestDeletion, resumeAccount, type AccountActionStatus, type AccountState } from "../../src/settings-data";
import { SignOutControls } from "../../src/sign-out";
import { ui } from "../../src/theme";
import { Button, openWebPage } from "../../src/ui";

const message = (status: AccountActionStatus) => status === "ok" ? "" : accountMessages[status];

/** The web's AccountDeleted: shown in place once the deletion succeeded, after every session has ended. */
function AccountDeleted() {
  const router = useRouter();
  return <ScrollView contentContainerStyle={ui.page}>
    <Text style={ui.title} accessibilityRole="header">{text.deletedTitle}</Text>
    <Text testID="account-deleted" style={[ui.note, { fontSize: 15 }]}>{text.deletedBody}</Text>
    <View style={ui.actions}><Button kind="secondary" label={text.top} onPress={() => router.replace("/")} /></View>
  </ScrollView>;
}

/** The web's DeleteDialog: the button stays disabled until the confirmation word matches exactly. */
function DeleteDialog({ onClose, onConfirm }: { onClose: () => void; onConfirm: (word: string) => Promise<AccountActionStatus> }) {
  const { services } = useAuth();
  const [word, setWord] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const running = useRef(false);
  async function submit() {
    if (running.current || word !== DELETE_CONFIRMATION) return;
    running.current = true; setBusy(true); setStatus("");
    try { setStatus(message(await onConfirm(word))); } catch { setStatus(accountMessages.unavailable); }
    finally { running.current = false; setBusy(false); }
  }
  return <Dialog testID="delete-dialog" title={text.dialogTitle} onClose={() => { if (!running.current) onClose(); }}>
    <Text style={ui.body}>{text.dialogBody}{services ? <Text testID="delete-privacy" style={ui.textLinkText} accessibilityRole="link"
      onPress={() => openWebPage(services.privacyUrl)}>{text.privacy}</Text> : text.privacy}{text.dialogBodyEnd}</Text>
    <View>
      <Text style={ui.label}>{text.confirmBefore}{DELETE_CONFIRMATION}{text.confirmAfter}</Text>
      <TextInput testID="delete-word" value={word} onChangeText={setWord} editable={!busy} autoCapitalize="none" autoCorrect={false}
        autoComplete="off" accessibilityLabel={`${text.confirmBefore}${DELETE_CONFIRMATION}${text.confirmAfter}`} style={ui.input} />
    </View>
    <Button testID="delete-submit" label={text.submit} disabled={busy || word !== DELETE_CONFIRMATION} busy={busy} onPress={() => void submit()} />
    <Button testID="delete-cancel" kind="secondary" label={text.cancel} disabled={busy} onPress={onClose} />
    <Text testID="delete-status" accessibilityLiveRegion="polite" style={ui.message}>{status}</Text>
  </Dialog>;
}

// MOBILE-004: the web's /settings/account (src/components/account-settings.tsx): pause and resume
// (deactivate_account, reactivate_account), deletion (request_account_deletion with the web's word "退会する"), and
// sign-out everywhere (docs/42 §2 #13–#14). After a deletion every session ends and the Keychain session is cleared,
// as the web's deleteAccount signs out globally; the account is already deleted, so a revoke that Auth does not
// confirm changes nothing the user can do (every gate and the sign-in API refuse a deleted account).
export default function AccountScreen() {
  const { ready, signedIn, services, signOutEverywhere } = useAuth();
  const router = useRouter();
  const { value, reload } = useLoad((s) => loadAccount(s.supabase), "account");
  const [state, setState] = useState<AccountState | null>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const running = useRef(false);
  useEffect(() => { if (value?.status === "ok") setState(value.accountStatus); }, [value]);

  // The deleted screen first: it stays after the session ends.
  if (deleted) return <AccountDeleted />;
  if (leaving) return <View style={ui.page} />;
  const blocked = gateView(ready, signedIn, !!services, value, LOAD_UNAVAILABLE, text.title);
  if (blocked) return blocked;
  if (!state || !services) return <View style={ui.page} />;
  const current = state;

  async function toggle() {
    if (running.current || current === "suspended" || !services) return;
    running.current = true; setBusy(true); setStatus("");
    const pausing = current === "active";
    try {
      const result = await (pausing ? pauseAccount : resumeAccount)(services.supabase);
      if (result === "ok") { setState(pausing ? "deactivated" : "active"); setStatus(pausing ? text.paused : text.resumed); }
      else { setStatus(message(result)); if (result === "invalid_state") void reload(); }
    } catch { setStatus(accountMessages.unavailable); }
    finally { running.current = false; setBusy(false); }
  }
  async function remove(word: string): Promise<AccountActionStatus> {
    if (!services) return "unavailable";
    const result = await requestDeletion(services.supabase, word);
    if (result !== "ok") return result;
    setDeleted(true);
    await signOutEverywhere().catch(() => {});
    return result;
  }

  return <ScrollView contentContainerStyle={ui.page}>
    <Button kind="small" label={text.back} style={{ alignSelf: "flex-start" }}
      onPress={() => { if (router.canGoBack()) router.back(); else router.replace("/mypage"); }} />
    <Text style={[ui.title, { marginTop: 16 }]} accessibilityRole="header">{text.title}</Text>
    <View style={ui.section} accessibilityLabel={text.pause}>
      <Text style={ui.sectionTitle} accessibilityRole="header">{text.pause}</Text>
      <Text style={[ui.note, { marginTop: 0, fontSize: 15, lineHeight: 26 }]}>{PAUSE_NOTE}</Text>
      {current === "suspended" ? <Text testID="account-state" style={ui.body}>{text.suspended}</Text> : <>
        <Text testID="account-state" style={ui.body}>{current === "deactivated" ? text.deactivated : text.active}</Text>
        <Button testID="account-toggle" kind="secondary" label={current === "deactivated" ? text.resume : text.doPause} disabled={busy} busy={busy}
          onPress={() => void toggle()} />
      </>}
      <Text testID="account-status" accessibilityLiveRegion="polite" style={ui.message}>{status}</Text>
    </View>
    <View style={ui.section} accessibilityLabel={text.delete}>
      <Text style={ui.sectionTitle} accessibilityRole="header">{text.delete}</Text>
      <Text style={[ui.note, { marginTop: 0, fontSize: 15 }]}>{text.irreversible}</Text>
      <Button testID="account-delete" kind="secondary" label={text.toDelete} onPress={() => setDeleting(true)} />
    </View>
    <SignOutControls local={false} onLeaving={() => setLeaving(true)} />
    {deleting ? <DeleteDialog onClose={() => setDeleting(false)} onConfirm={remove} /> : null}
  </ScrollView>;
}
