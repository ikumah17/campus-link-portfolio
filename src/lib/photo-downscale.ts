// UI-014: the browser shrinks a photo before uploading it. The server still decodes and re-encodes every upload
// (1600×1600 WebP at quality 82), so this only saves bytes on the wire and drops the original's metadata.
// FIX-004: 4 MiB, shared with the server, so a part plus the multipart overhead stays under Vercel's ~4.5 MB body limit.
export const MAX_PHOTO_BYTES = 4_194_304;
export const PHOTO_TYPES: readonly string[] = ["image/jpeg", "image/png", "image/webp"];
export const DOWNSCALE_MAX_EDGE = 1600;
export const DOWNSCALE_QUALITY = 0.85;
const extensions: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

// Fits the image inside DOWNSCALE_MAX_EDGE × DOWNSCALE_MAX_EDGE, keeping the aspect ratio and never enlarging.
export function targetSize(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, DOWNSCALE_MAX_EDGE / width, DOWNSCALE_MAX_EDGE / height);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

function encode(canvas: HTMLCanvasElement, type: string): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, DOWNSCALE_QUALITY));
}

// Returns a smaller WebP (or JPEG where the browser cannot encode WebP), or null when the original should be sent:
// the browser cannot decode or encode it (for example HEIC), or the result is not smaller.
export async function downscalePhoto(file: Blob): Promise<Blob | null> {
  if (typeof createImageBitmap !== "function") return null;
  let bitmap: ImageBitmap | undefined;
  let canvas: HTMLCanvasElement | undefined;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const { width, height } = targetSize(bitmap.width, bitmap.height);
    canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    bitmap = undefined;
    let blob = await encode(canvas, "image/webp");
    if (blob?.type !== "image/webp") {
      // JPEG has no alpha: paint transparent pixels white instead of black.
      context.globalCompositeOperation = "destination-over";
      context.fillStyle = "#fff";
      context.fillRect(0, 0, width, height);
      blob = await encode(canvas, "image/jpeg");
      if (blob?.type !== "image/jpeg") return null;
    }
    return blob.size < file.size ? blob : null;
  } catch {
    return null;
  } finally {
    bitmap?.close();
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
}

// The part to upload under a neutral file name: the user's file name never leaves the device.
export async function preparePhoto(file: File): Promise<File> {
  const smaller = await downscalePhoto(file);
  const part = smaller ?? file;
  return new File([part], `photo.${extensions[part.type] ?? "img"}`, { type: part.type });
}
