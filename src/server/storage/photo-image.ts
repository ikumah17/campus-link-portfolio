import "server-only";
import sharp from "sharp";

class PhotoRejected extends Error {
  constructor() {
    super("Photo rejected");
  }
}

function rejectAnimatedPng(input: Buffer): void {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!input.subarray(0, 8).equals(signature)) throw new PhotoRejected();
  // Sharp can decode APNG as PNG without reporting pages. Inspect actual chunk
  // boundaries, not arbitrary byte matches inside image data or metadata.
  for (let offset = 8; offset <= input.length - 12;) {
    const length = input.readUInt32BE(offset);
    if (length > input.length - offset - 12) throw new PhotoRejected();
    const type = input.toString("latin1", offset + 4, offset + 8);
    if (type === "acTL") throw new PhotoRejected();
    if (type === "IEND" && length === 0) return;
    offset += length + 12;
  }
  throw new PhotoRejected();
}

export async function reencodePhoto(input: Buffer): Promise<Buffer> {
  try {
    const image = sharp(input, { limitInputPixels: 40_000_000, failOn: "warning" });
    const metadata = await image.metadata();
    if (!metadata.format || !["jpeg", "png", "webp"].includes(metadata.format) || (metadata.pages ?? 1) > 1) {
      throw new PhotoRejected();
    }
    if (metadata.format === "png") rejectAnimatedPng(input);
    // Sharp strips metadata by default and converts the pixels to sRGB.
    return await image.rotate().resize(1600, 1600, { fit: "inside", withoutEnlargement: true })
      .toColourspace("srgb").webp({ quality: 82 }).toBuffer();
  } catch {
    // Decoder messages may contain untrusted input details; keep them private.
    throw new PhotoRejected();
  }
}
