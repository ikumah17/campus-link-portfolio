import { File } from "expo-file-system";
import * as Manipulator from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";
import { base64Bytes, createPhotoApi, photoSource, pickPhoto, preparePhoto, reorderPhotos } from "../src/photos";
import { MAX_PHOTO_BYTES } from "../src/shared";
import { done, fakeSupabase, PHOTO_A, PHOTO_B } from "./fake-supabase";

jest.mock("expo-image-picker", () => ({ launchImageLibraryAsync: jest.fn() }));
jest.mock("expo-file-system", () => ({
  File: jest.fn().mockImplementation((uri: string) => ({ uri, bytes: jest.fn(async () => new TextEncoder().encode(`JPEG:${uri}`)) })),
}));
jest.mock("expo-image-manipulator", () => {
  const made: { width: number; height: number; release: jest.Mock; saveAsync: jest.Mock }[] = [];
  const image = (width: number, height: number) => {
    const ref = { width, height, release: jest.fn(), saveAsync: jest.fn(async () => ({ uri: "file:///cache/out.jpg", width, height, base64: "QUJD" })) };
    made.push(ref);
    return ref;
  };
  const contexts: { source: unknown; options?: unknown; resized?: { width: number; height: number } }[] = [];
  return {
    __made: made,
    __contexts: contexts,
    __decoded: { width: 1600, height: 1200 },
    SaveFormat: { JPEG: "jpeg", PNG: "png", WEBP: "webp" },
    ImageManipulator: {
      manipulate: jest.fn((source: unknown, options?: unknown) => {
        const context: (typeof contexts)[number] = { source, options };
        contexts.push(context);
        const api = {
          resize: (size: { width: number; height: number }) => { context.resized = size; return api; },
          renderAsync: async () => {
            const decoded = (jest.requireMock("expo-image-manipulator") as { __decoded: { width: number; height: number } }).__decoded;
            return context.resized ? image(context.resized.width, context.resized.height) : image(decoded.width, decoded.height);
          },
        };
        return api;
      }),
    },
  };
});

const mocked = Manipulator as unknown as {
  __made: { width: number; height: number; release: jest.Mock; saveAsync: jest.Mock }[];
  __contexts: { source: unknown; options?: unknown; resized?: { width: number; height: number } }[];
  __decoded: { width: number; height: number };
  ImageManipulator: { manipulate: jest.Mock };
};
// The app runs on React Native's FormData with Expo's patch (expo/src/winter/runtime.native.ts), and SDK 58's fetch
// encodes it with convertFormDataAsync; jest's environment has Node's FormData and a mocked fetch. A subclass keeps
// the patch off React Native's own class.
const { installFormDataPatch } = jest.requireActual("expo/src/winter/FormData");
const { convertFormDataAsync } = jest.requireActual("expo/src/winter/fetch/convertFormData");
const ExpoFormData = installFormDataPatch(class extends jest.requireActual("react-native/Libraries/Network/FormData").default {});
const nodeFormData = global.FormData;
beforeAll(() => { global.FormData = ExpoFormData; });
afterAll(() => { global.FormData = nodeFormData; });
const fileMock = File as unknown as jest.Mock;

/** The multipart body exactly as Expo's fetch would send it. */
async function encoded(body: unknown): Promise<string> {
  const { body: bytes, boundary } = await convertFormDataAsync(body, "BOUNDARY");
  expect(boundary).toBe("BOUNDARY");
  return new TextDecoder().decode(bytes);
}
function multipart(filename: string, type: string, content: string) {
  return ["--BOUNDARY", `content-disposition: form-data; name="photo"; filename="${filename}"`, `content-type: ${type}`, "", content, "--BOUNDARY--", ""].join("\r\n");
}
const picker = ImagePicker as unknown as { launchImageLibraryAsync: jest.Mock };
const jwt = "aaa.bbb.ccc";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  mocked.__made.length = 0;
  mocked.__contexts.length = 0;
  Object.assign(mocked.__decoded, { width: 1600, height: 1200 });
  jest.clearAllMocks();
});

describe("photo API", () => {
  const photo = { uri: "file:///cache/out.webp", name: "photo.webp", type: "image/webp", size: 1000 };

  it("uploads one neutral part with the Bearer token only", async () => {
    const fetcher = jest.fn(async () => json({ status: "ok" }));
    const api = createPhotoApi("http://192.168.1.10:3000", async () => jwt, fetcher);
    expect(await api.upload(photo)).toBe("ok");
    const [url, init] = (fetcher.mock.calls as unknown as [string, RequestInit][])[0];
    expect(url).toBe("http://192.168.1.10:3000/api/mobile/photos");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("omit");
    expect(init.headers).toEqual({ Authorization: `Bearer ${jwt}`, Accept: "application/json" });
    // FIX-007: a part with bytes(), which Expo's fetch supports, never React Native's { uri } part.
    const entries = [...(init.body as unknown as Iterable<[string, Record<string, unknown>]>)];
    expect(entries).toEqual([["photo", { name: "photo.webp", type: "image/webp", bytes: expect.any(Function) }]]);
    expect(fileMock).not.toHaveBeenCalled();
    expect(await encoded(init.body)).toBe(multipart("photo.webp", "image/webp", `JPEG:${photo.uri}`));
    expect(fileMock).toHaveBeenCalledWith(photo.uri);
  });

  it("sends a prepared JPEG under its own part name and type", async () => {
    const fetcher = jest.fn(async () => json({ status: "ok" }));
    const api = createPhotoApi("http://host:3000", async () => jwt, fetcher);
    const prepared = await preparePhoto({ uri: "file:///picked.heic" });
    expect(await api.upload(prepared!)).toBe("ok");
    const [, init] = (fetcher.mock.calls as unknown as [string, RequestInit][])[0];
    expect(await encoded(init.body)).toBe(multipart("photo.jpg", "image/jpeg", "JPEG:file:///cache/out.jpg"));
  });

  it("answers unavailable when fetch rejects, warning in development with the error only", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const api = createPhotoApi("http://host:3000", async () => jwt, async () => { throw new Error("Unsupported FormDataPart implementation"); });
    expect(await api.upload(photo)).toBe("unavailable");
    expect(warn.mock.calls).toEqual([["photo request failed: Error: Unsupported FormDataPart implementation"]]);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/file:|Bearer|aaa\.bbb/);
    warn.mockRestore();
  });

  it("answers unavailable when the prepared file cannot be read", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    fileMock.mockImplementationOnce(() => ({ bytes: async () => { throw new Error("missing"); } }));
    const api = createPhotoApi("http://host:3000", async () => jwt, async (_url, init) => { await encoded(init.body); return json({ status: "ok" }); });
    expect(await api.upload(photo)).toBe("unavailable");
    expect(warn.mock.calls).toEqual([["photo request failed: Error: missing"]]);
    warn.mockRestore();
  });

  it.each(["invalid", "too_large", "too_many", "rate_limited", "unauthenticated", "unavailable"])("keeps the route's %s answer", async (status) => {
    const api = createPhotoApi("http://host:3000", async () => jwt, async () => json({ status }, 400));
    expect(await api.upload(photo)).toBe(status);
  });

  it("maps Vercel's plain 413, other pages and network errors", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    expect(await createPhotoApi("http://host:3000", async () => jwt, async () => new Response("Too large", { status: 413 })).upload(photo)).toBe("too_large");
    expect(await createPhotoApi("http://host:3000", async () => jwt, async () => new Response("<html>", { status: 200, headers: { "Content-Type": "text/html" } })).upload(photo)).toBe("unavailable");
    expect(await createPhotoApi("http://host:3000", async () => jwt, async () => { throw new TypeError("offline"); }).upload(photo)).toBe("unavailable");
    expect(await createPhotoApi("http://host:3000", async () => jwt, async () => json({ status: "ok" }, 503)).upload(photo)).toBe("unavailable");
    warn.mockRestore();
  });

  it("sends nothing without a session or over 4 MiB", async () => {
    const fetcher = jest.fn(async () => json({ status: "ok" }));
    expect(await createPhotoApi("http://host:3000", async () => null, fetcher).upload(photo)).toBe("unauthenticated");
    expect(await createPhotoApi("http://host:3000", async () => jwt, fetcher).upload({ ...photo, size: MAX_PHOTO_BYTES + 1 })).toBe("too_large");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("removes a photo by DELETE and maps the answers", async () => {
    const fetcher = jest.fn(async () => json({ status: "last_photo" }, 409));
    const api = createPhotoApi("http://host:3000", async () => jwt, fetcher);
    expect(await api.remove(PHOTO_A)).toBe("last_photo");
    const [url, init] = (fetcher.mock.calls as unknown as [string, RequestInit][])[0];
    expect(url).toBe(`http://host:3000/api/mobile/photos/${PHOTO_A}`);
    expect(init.method).toBe("DELETE");
    expect(await api.remove("../etc")).toBe("invalid");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("builds the delivery source with the Bearer header", () => {
    expect(photoSource("http://host:3000", PHOTO_A, jwt)).toEqual({
      uri: `http://host:3000/api/mobile/photos/${PHOTO_A}`, headers: { Authorization: `Bearer ${jwt}` },
    });
  });

  it("reorders with the web's checks", async () => {
    const fake = fakeSupabase(() => done());
    expect(await reorderPhotos(fake, [PHOTO_B, PHOTO_A])).toBe("ok");
    expect(fake.rpc).toHaveBeenCalledWith("reorder_photos", { p_ids: [PHOTO_B, PHOTO_A] });
    expect(await reorderPhotos(fake, [PHOTO_A, PHOTO_A])).toBe("invalid");
    expect(await reorderPhotos(fake, [])).toBe("invalid");
  });
});

describe("photo preparation", () => {
  it("picks one image from the library without EXIF", async () => {
    picker.launchImageLibraryAsync.mockResolvedValueOnce({ canceled: false, assets: [{ uri: "file:///picked.heic", width: 4032, height: 3024, fileName: "IMG_0001.HEIC" }] });
    expect(await pickPhoto()).toEqual({ uri: "file:///picked.heic" });
    expect(picker.launchImageLibraryAsync).toHaveBeenCalledWith(expect.objectContaining({ mediaTypes: ["images"], allowsMultipleSelection: false, exif: false }));
    picker.launchImageLibraryAsync.mockResolvedValueOnce({ canceled: true, assets: null });
    expect(await pickPhoto()).toBeNull();
  });

  it("decodes within 1600 px and saves JPEG, which iOS encodes natively, at the web's quality under a neutral name", async () => {
    const prepared = await preparePhoto({ uri: "file:///picked.heic" });
    expect(mocked.__contexts[0]).toEqual({ source: "file:///picked.heic", options: { maxWidth: 1600, maxHeight: 1600 } });
    expect(mocked.__contexts).toHaveLength(1);
    expect(mocked.__made[0].saveAsync).toHaveBeenCalledWith({ format: "jpeg", compress: 0.85, base64: true });
    expect(prepared).toEqual({ uri: "file:///cache/out.jpg", name: "photo.jpg", type: "image/jpeg", size: 3 });
    expect(mocked.__made.every((ref) => ref.release.mock.calls.length === 1)).toBe(true);
  });

  it("resizes when the decoded image is still larger than 1600 px", async () => {
    Object.assign(mocked.__decoded, { width: 3200, height: 1800 });
    await preparePhoto({ uri: "file:///picked.jpg" });
    expect(mocked.__contexts[1].resized).toEqual({ width: 1600, height: 900 });
    expect(mocked.__made[1].saveAsync).toHaveBeenCalled();
  });

  it("answers null for an image that cannot be decoded, warning with the error class only", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    mocked.ImageManipulator.manipulate.mockImplementationOnce(() => ({ renderAsync: async () => { throw new RangeError("file:///broken secret"); } }));
    expect(await preparePhoto({ uri: "file:///broken" })).toBeNull();
    expect(warn.mock.calls).toEqual([["photo prepare failed: RangeError"]]);
    warn.mockRestore();
  });

  it("answers null and releases the image when encoding fails or returns nothing", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    mocked.ImageManipulator.manipulate.mockImplementationOnce(() => ({
      renderAsync: async () => {
        const ref = { width: 800, height: 600, release: jest.fn(), saveAsync: jest.fn(async () => { throw new Error("encode"); }) };
        mocked.__made.push(ref);
        return ref;
      },
    }));
    expect(await preparePhoto({ uri: "file:///picked.heic" })).toBeNull();
    expect(mocked.__made[0].release).toHaveBeenCalledTimes(1);
    mocked.ImageManipulator.manipulate.mockImplementationOnce(() => ({
      renderAsync: async () => ({ width: 800, height: 600, release: jest.fn(), saveAsync: jest.fn(async () => ({ uri: "", width: 800, height: 600 })) }),
    }));
    expect(await preparePhoto({ uri: "file:///picked.heic" })).toBeNull();
    expect(warn.mock.calls).toEqual([["photo prepare failed: Error"], ["photo prepare failed: TypeError"]]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("file://");
    warn.mockRestore();
  });

  it("measures base64 exactly", () => {
    expect(base64Bytes("QUJD")).toBe(3);
    expect(base64Bytes("QUI=")).toBe(2);
    expect(base64Bytes("QQ==")).toBe(1);
  });
});
