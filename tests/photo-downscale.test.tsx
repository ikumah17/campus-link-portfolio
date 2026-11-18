import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DOWNSCALE_MAX_EDGE, DOWNSCALE_QUALITY, downscalePhoto, preparePhoto, targetSize } from "@/lib/photo-downscale";

// UI-014: jsdom has neither createImageBitmap nor a 2D canvas, so both are stand-ins that record what was drawn.
const bitmap = { width: 3000, height: 2000, close: vi.fn() };
const context = { drawImage: vi.fn(), fillRect: vi.fn(), imageSmoothingQuality: "low", globalCompositeOperation: "source-over", fillStyle: "" };
let encoded: (type: string) => Blob | null;
let canvases: { canvas: HTMLCanvasElement; width: number; height: number; type: string; quality: unknown }[];
const original = (bytes = 4096, type = "image/png", name = "IMG_0001 private name.png") => new File([new Uint8Array(bytes)], name, { type });
beforeEach(() => {
  bitmap.width = 3000; bitmap.height = 2000; bitmap.close.mockReset();
  context.drawImage.mockReset(); context.fillRect.mockReset(); context.globalCompositeOperation = "source-over";
  canvases = [];
  encoded = (type) => new Blob([new Uint8Array(100)], { type });
  vi.stubGlobal("createImageBitmap", vi.fn(async () => bitmap));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (this: HTMLCanvasElement, callback, type, quality) {
    canvases.push({ canvas: this, width: this.width, height: this.height, type: type!, quality });
    callback(encoded(type!));
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("targetSize", () => {
  it.each([
    ["landscape", 3000, 2000, 1600, 1067],
    ["portrait", 2000, 3000, 1067, 1600],
    ["square", 4000, 4000, 1600, 1600],
    ["already small", 800, 600, 800, 600],
    ["exactly 1600", 1600, 1600, 1600, 1600],
    ["1600 on the long side", 1600, 900, 1600, 900],
    ["very narrow", 16000, 4, 1600, 1],
  ])("fits a %s image inside 1600×1600 without enlarging", (_, width, height, expectedWidth, expectedHeight) => {
    expect(targetSize(width, height)).toEqual({ width: expectedWidth, height: expectedHeight });
  });
});

describe("downscalePhoto", () => {
  it("replaces a large image with a smaller WebP drawn at the target size, then releases the bitmap and canvas", async () => {
    const file = original();
    const result = await downscalePhoto(file);
    expect(result?.type).toBe("image/webp");
    expect(result?.size).toBe(100);
    expect(createImageBitmap).toHaveBeenCalledExactlyOnceWith(file, { imageOrientation: "from-image" });
    expect(context.drawImage).toHaveBeenCalledExactlyOnceWith(bitmap, 0, 0, 1600, 1067);
    expect(canvases).toEqual([expect.objectContaining({ width: 1600, height: 1067, type: "image/webp", quality: DOWNSCALE_QUALITY })]);
    expect(DOWNSCALE_MAX_EDGE).toBe(1600); expect(DOWNSCALE_QUALITY).toBe(0.85);
    expect(bitmap.close).toHaveBeenCalledOnce();
    expect(canvases[0].canvas.width).toBe(0); expect(canvases[0].canvas.height).toBe(0);
  });
  it("falls back to JPEG on a white background when the browser does not return WebP", async () => {
    encoded = (type) => new Blob([new Uint8Array(type === "image/webp" ? 50 : 200)], { type: type === "image/webp" ? "image/png" : type });
    const result = await downscalePhoto(original());
    expect(result?.type).toBe("image/jpeg");
    expect(canvases.map(({ type, quality }) => [type, quality])).toEqual([["image/webp", 0.85], ["image/jpeg", 0.85]]);
    expect(context.globalCompositeOperation).toBe("destination-over");
    expect(context.fillRect).toHaveBeenCalledWith(0, 0, 1600, 1067);
    expect(bitmap.close).toHaveBeenCalledOnce();
  });
  it("keeps the original when neither WebP nor JPEG is returned", async () => {
    encoded = (type) => (type === "image/webp" ? new Blob([new Uint8Array(10)], { type: "image/png" }) : null);
    expect(await downscalePhoto(original())).toBeNull();
    expect(bitmap.close).toHaveBeenCalledOnce();
  });
  it("keeps the original when the result is not smaller", async () => {
    bitmap.width = 400; bitmap.height = 300;
    encoded = (type) => new Blob([new Uint8Array(4096)], { type });
    expect(await downscalePhoto(original(4096))).toBeNull();
    expect(context.drawImage).toHaveBeenCalledWith(bitmap, 0, 0, 400, 300);
  });
  it("keeps the original when decoding fails, for example HEIC", async () => {
    vi.mocked(createImageBitmap).mockRejectedValueOnce(new DOMException("private decoder detail", "InvalidStateError"));
    expect(await downscalePhoto(original())).toBeNull();
    expect(canvases).toEqual([]);
  });
  it("keeps the original and closes the bitmap when encoding throws or no 2D context exists", async () => {
    vi.mocked(HTMLCanvasElement.prototype.toBlob).mockImplementationOnce(() => { throw new Error("SecurityError"); });
    expect(await downscalePhoto(original())).toBeNull();
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValueOnce(null);
    expect(await downscalePhoto(original())).toBeNull();
    expect(bitmap.close).toHaveBeenCalledTimes(2);
  });
  it("keeps the original when the browser has no createImageBitmap", async () => {
    vi.stubGlobal("createImageBitmap", undefined);
    expect(await downscalePhoto(original())).toBeNull();
  });
});

describe("preparePhoto", () => {
  it("names the shrunk part photo.webp, never the user's file name", async () => {
    const part = await preparePhoto(original());
    expect(part.name).toBe("photo.webp"); expect(part.type).toBe("image/webp"); expect(part.size).toBe(100);
  });
  it("names a JPEG fallback photo.jpg", async () => {
    encoded = (type) => new Blob([new Uint8Array(100)], { type: type === "image/webp" ? "image/png" : type });
    const part = await preparePhoto(original());
    expect(part.name).toBe("photo.jpg"); expect(part.type).toBe("image/jpeg");
  });
  it.each([["image/jpeg", "photo.jpg"], ["image/png", "photo.png"], ["image/webp", "photo.webp"]])(
    "sends an undecodable %s original byte for byte under %s", async (type, name) => {
      vi.mocked(createImageBitmap).mockRejectedValueOnce(new Error("decode failed"));
      const file = new File([new Uint8Array([1, 2, 3, 4])], "private name.bin", { type });
      const part = await preparePhoto(file);
      expect(part.name).toBe(name); expect(part.type).toBe(type);
      expect(new Uint8Array(await part.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
    });
});
