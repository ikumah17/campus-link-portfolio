import { Image } from "expo-image";
import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { listMyPhotos } from "./account-data";
import { useAuth } from "./auth-context";
import { photoMessages } from "./messages";
import { MAX_PHOTOS, photoSource, pickPhoto, preparePhoto, reorderPhotos, warnPhotoFailure } from "./photos";
import { MAX_PHOTO_BYTES } from "./shared";
import { ui } from "./theme";
import { Alert, Button, SessionExpired } from "./ui";

type Failure = keyof typeof photoMessages;

// MOBILE-002: the web's src/components/photo-manager.tsx on the device. A photo is picked from the library, shrunk
// and re-encoded on the device, then uploaded; the registered list is always re-read from the database afterwards,
// because registration fills the first vacant position (the main photo may not be the new one).
export function PhotoManager({ initial, onChange, onPendingChange, disabled = false }: {
  initial: string[];
  onChange?: (ids: string[]) => void;
  onPendingChange?: (pending: boolean) => void;
  disabled?: boolean;
}) {
  const { services } = useAuth();
  const [ids, setIds] = useState(initial);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const running = useRef(false);
  const busy = pending || disabled;
  const key = ids.join(",");

  // The delivery token is re-read whenever the list changes, so an image request never carries a stale token.
  useEffect(() => {
    let active = true;
    if (services && key) void services.photos.token().then((value) => { if (active) setToken(value); });
    return () => { active = false; };
  }, [services, key]);

  if (!services) return null;
  const { photos, supabase, apiBaseUrl } = services;

  function update(next: string[]) { setIds(next); onChange?.(next); }
  async function refresh() {
    setNeedsRefresh(true);
    update([]);
    const next = await listMyPhotos(supabase);
    if (next === null) setFailure("unavailable");
    else {
      update(next);
      setNeedsRefresh(false);
      setFailure(null);
    }
  }
  async function run(operation: () => Promise<void>) {
    if (running.current || disabled) return;
    running.current = true;
    setPending(true); onPendingChange?.(true); setFailure(null);
    try { await operation(); } catch (error) {
      // FIX-006: a picker or request that throws is shown, never swallowed.
      warnPhotoFailure("request", error);
      setFailure("unavailable");
    } finally {
      running.current = false;
      setPending(false); onPendingChange?.(false);
    }
  }
  function add() {
    if (running.current || disabled || needsRefresh) return;
    if (ids.length >= MAX_PHOTOS) { setFailure("too_many"); return; }
    void run(async () => {
      const picked = await pickPhoto();
      if (!picked) return;
      // UI-014: an image that cannot be decoded is invalid; one still over 4 MiB after shrinking is too_large.
      const part = await preparePhoto(picked);
      if (!part) { setFailure("invalid"); return; }
      if (part.size > MAX_PHOTO_BYTES) { setFailure("too_large"); return; }
      const status = await photos.upload(part);
      if (status === "ok") await refresh();
      else setFailure(status);
    });
  }
  function reorder(index: number, direction: number) {
    const next = [...ids];
    [next[index], next[index + direction]] = [next[index + direction], next[index]];
    void run(async () => {
      const status = await reorderPhotos(supabase, next);
      if (status === "ok") update(next);
      else setFailure(status);
    });
  }
  function remove(id: string) {
    void run(async () => {
      const status = await photos.remove(id);
      if (status === "ok") update(ids.filter((value) => value !== id));
      else setFailure(status);
    });
  }

  return <View accessibilityLabel="登録する写真" accessibilityState={{ busy }} style={{ gap: 20 }}>
    <View>
      <Button testID="photo-add" label="写真を追加" kind="secondary" onPress={add} busy={pending}
        disabled={busy || needsRefresh || ids.length >= MAX_PHOTOS} />
      <Text style={ui.hint}>JPEG、PNG、WebP・4MB以下・6枚まで</Text>
    </View>
    {failure === "unauthenticated" ? <SessionExpired /> : failure ? <Alert testID="photo-message"><Text style={ui.message}>{photoMessages[failure]}</Text></Alert> : null}
    {needsRefresh ? <Button testID="photo-refresh" label="写真を再読み込み" kind="small" disabled={busy} onPress={() => void run(refresh)} /> : null}
    <View accessibilityLabel="登録した写真" style={{ gap: 20 }}>
      {ids.map((id, index) => <View key={id} testID="photo-item" style={ui.photoCard}>
        {token ? <Image testID={`photo-${index}`} source={photoSource(apiBaseUrl, id, token)} cachePolicy="memory" contentFit="cover"
          style={ui.photo} accessibilityLabel={`登録した写真 ${index + 1}`} /> : <View style={ui.photo} />}
        <Text style={ui.body}>{index === 0 ? "メイン" : `写真 ${index + 1}`}</Text>
        <View style={ui.rowTight}>
          <Button kind="small" label="前へ" disabled={busy || index === 0} onPress={() => reorder(index, -1)} />
          <Button kind="small" label="後へ" disabled={busy || index === ids.length - 1} onPress={() => reorder(index, 1)} />
          <Button testID={`photo-remove-${index}`} kind="small" label="削除" disabled={busy} onPress={() => remove(id)} />
        </View>
      </View>)}
    </View>
  </View>;
}
