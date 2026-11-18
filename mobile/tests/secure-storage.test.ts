import * as SecureStore from "expo-secure-store";
import { CHUNK_SIZE, KEYCHAIN_OPTIONS, secureSessionStorage, splitChunks } from "../src/secure-storage";

jest.mock("expo-secure-store", () => {
  const store = new Map<string, string>();
  return {
    AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 4,
    __store: store,
    getItemAsync: jest.fn(async (key: string) => store.get(key) ?? null),
    setItemAsync: jest.fn(async (key: string, value: string) => { store.set(key, value); }),
    deleteItemAsync: jest.fn(async (key: string) => { store.delete(key); }),
  };
});

const mocked = SecureStore as unknown as {
  __store: Map<string, string>;
  getItemAsync: jest.Mock; setItemAsync: jest.Mock; deleteItemAsync: jest.Mock;
};

beforeEach(() => {
  mocked.__store.clear();
  jest.clearAllMocks();
});

describe("Keychain session storage", () => {
  it("keeps every value this-device-only, after the first unlock", async () => {
    await secureSessionStorage.setItem("campus-link.session", "{\"a\":1}");
    await secureSessionStorage.getItem("campus-link.session");
    await secureSessionStorage.removeItem("campus-link.session");
    expect(KEYCHAIN_OPTIONS.keychainAccessible).toBe(SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY);
    for (const mock of [mocked.getItemAsync, mocked.setItemAsync, mocked.deleteItemAsync]) {
      expect(mock).toHaveBeenCalled();
      for (const call of mock.mock.calls) expect(call[call.length - 1]).toBe(KEYCHAIN_OPTIONS);
    }
  });

  it("round-trips a session larger than one Keychain value in chunks", async () => {
    const session = JSON.stringify({ access_token: "x".repeat(5000), user: { name: "学生😀".repeat(400) } });
    await secureSessionStorage.setItem("campus-link.session", session);
    for (const [key, value] of mocked.__store) if (key !== "campus-link.session.n") expect(value.length).toBeLessThanOrEqual(CHUNK_SIZE);
    expect(Number(mocked.__store.get("campus-link.session.n"))).toBeGreaterThan(1);
    expect(await secureSessionStorage.getItem("campus-link.session")).toBe(session);
  });

  it("never splits a surrogate pair", () => {
    const value = "a".repeat(CHUNK_SIZE - 1) + "😀" + "b";
    const chunks = splitChunks(value);
    expect(chunks.join("")).toBe(value);
    expect(chunks[0]).toBe("a".repeat(CHUNK_SIZE - 1));
    expect(chunks[1]).toBe("😀b");
  });

  it("reads no session when nothing or only part was saved", async () => {
    expect(await secureSessionStorage.getItem("campus-link.session")).toBeNull();
    mocked.__store.set("campus-link.session.n", "2");
    mocked.__store.set("campus-link.session.0", "{\"half\":");
    expect(await secureSessionStorage.getItem("campus-link.session")).toBeNull();
    expect(mocked.__store.size).toBe(0);
  });

  it("removes every chunk, including leftovers of a larger earlier session", async () => {
    await secureSessionStorage.setItem("campus-link.session", "y".repeat(CHUNK_SIZE * 3));
    await secureSessionStorage.setItem("campus-link.session", "short");
    expect(mocked.__store.get("campus-link.session.n")).toBe("1");
    expect(mocked.__store.has("campus-link.session.2")).toBe(false);
    await secureSessionStorage.removeItem("campus-link.session");
    expect(mocked.__store.size).toBe(0);
  });

  it("refuses a key the Keychain would not accept", async () => {
    await expect(secureSessionStorage.setItem("bad key", "v")).rejects.toThrow();
  });
});
