import * as SecureStore from "expo-secure-store";

// MOBILE-001 (docs/42 §3.1): the Supabase session lives only in the iOS Keychain, readable after the first unlock and
// on this device only, so it never moves to an iCloud backup or another device. A session can exceed the size one
// Keychain value should hold, so it is split into chunks under one key; nothing goes to plain storage.
export const KEYCHAIN_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};
export const CHUNK_SIZE = 1800;
const MAX_CHUNKS = 32;
const KEY = /^[A-Za-z0-9._-]+$/;

const countKey = (key: string) => `${key}.n`;
const chunkKey = (key: string, index: number) => `${key}.${index}`;

function checkedKey(key: string): string {
  if (!KEY.test(key)) throw new Error("Invalid secure storage key");
  return key;
}

async function storedCount(key: string): Promise<number> {
  const raw = await SecureStore.getItemAsync(countKey(key), KEYCHAIN_OPTIONS);
  const count = raw !== null && /^\d{1,2}$/.test(raw) ? Number(raw) : 0;
  return count <= MAX_CHUNKS ? count : 0;
}

// Every chunk slot is cleared, so no piece of an earlier or interrupted save outlives a sign-out.
async function removeItem(key: string): Promise<void> {
  checkedKey(key);
  await SecureStore.deleteItemAsync(countKey(key), KEYCHAIN_OPTIONS);
  for (let index = 0; index < MAX_CHUNKS; index += 1) {
    await SecureStore.deleteItemAsync(chunkKey(key, index), KEYCHAIN_OPTIONS);
  }
}

async function getItem(key: string): Promise<string | null> {
  checkedKey(key);
  const count = await storedCount(key);
  if (count === 0) return null;
  const chunks: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const chunk = await SecureStore.getItemAsync(chunkKey(key, index), KEYCHAIN_OPTIONS);
    if (chunk === null) {
      // A partial write (the app stopped mid-save) is no session: clear it rather than return a broken value.
      await removeItem(key);
      return null;
    }
    chunks.push(chunk);
  }
  return chunks.join("");
}

/** Pieces of at most CHUNK_SIZE UTF-16 units that never split a surrogate pair. */
export function splitChunks(value: string): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < value.length) {
    let end = Math.min(start + CHUNK_SIZE, value.length);
    const last = value.charCodeAt(end - 1);
    if (end < value.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    chunks.push(value.slice(start, end));
    start = end;
  }
  return chunks.length ? chunks : [""];
}

async function setItem(key: string, value: string): Promise<void> {
  checkedKey(key);
  const chunks = splitChunks(value);
  if (chunks.length > MAX_CHUNKS) throw new Error("Secure storage value too large");
  await removeItem(key);
  for (const [index, chunk] of chunks.entries()) {
    await SecureStore.setItemAsync(chunkKey(key, index), chunk, KEYCHAIN_OPTIONS);
  }
  // The count is written last, so an interrupted save reads as no session.
  await SecureStore.setItemAsync(countKey(key), String(chunks.length), KEYCHAIN_OPTIONS);
}

/** The storage supabase-js keeps its session in (`auth.storage`). */
export const secureSessionStorage = { getItem, setItem, removeItem };
