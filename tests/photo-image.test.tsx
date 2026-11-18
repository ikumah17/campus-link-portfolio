// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
vi.mock("server-only", () => ({}));
import { reencodePhoto } from "@/server/storage/photo-image";

let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => { fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network forbidden")); });
afterEach(() => { expect(fetchSpy).not.toHaveBeenCalled(); vi.restoreAllMocks(); });
const image = (width: number, height: number) => sharp({ create: { width, height, channels: 3, background: "#c08040" } });

function pngChunk(type: string, data: Buffer): Buffer {
  const content = Buffer.concat([Buffer.from(type, "ascii"), data]);
  let crc = 0xffffffff;
  for (const byte of content) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, content, checksum]);
}

function pngChunks(input: Buffer): { type: string; data: Buffer }[] {
  const chunks = [];
  for (let offset = 8; offset < input.length;) {
    const length = input.readUInt32BE(offset);
    chunks.push({ type: input.toString("ascii", offset + 4, offset + 8), data: input.subarray(offset + 8, offset + 8 + length) });
    offset += length + 12;
  }
  return chunks;
}

describe("photo re-encoding with real sharp", () => {
  it.each(["jpeg", "png", "webp"] as const)("accepts %s content and returns bounded WebP", async (format) => {
    const input = await image(2400, 1200).toFormat(format).toBuffer();
    const output = await reencodePhoto(input);
    const meta = await sharp(output).metadata();
    expect(meta.format).toBe("webp");
    expect([meta.width, meta.height]).toEqual([1600, 800]);
    expect(output.equals(input)).toBe(false);
  });
  it("applies EXIF orientation and removes GPS, XMP and ICC metadata", async () => {
    const input = await image(80, 40).withMetadata({ orientation: 6 })
      .withExifMerge({ IFD0: { Copyright: "synthetic fixture" }, IFD3: {
        GPSLatitudeRef: "N", GPSLatitude: "35/1 0/1 0/1", GPSLongitudeRef: "E", GPSLongitude: "139/1 0/1 0/1",
      } }).withXmp('<x:xmpmeta xmlns:x="adobe:ns:meta/">synthetic location</x:xmpmeta>').jpeg().toBuffer();
    const original = await sharp(input).metadata();
    expect(original.orientation).toBe(6);
    expect(original.exif).toBeDefined();
    // Check the TIFF GPS IFD pointer, so a fixture without GPS cannot pass.
    const tiff = original.exif!.subarray(6);
    const little = tiff.toString("ascii", 0, 2) === "II";
    const read16 = (offset: number) => little ? tiff.readUInt16LE(offset) : tiff.readUInt16BE(offset);
    const read32 = (offset: number) => little ? tiff.readUInt32LE(offset) : tiff.readUInt32BE(offset);
    const ifd = read32(4);
    const gpsEntry = Array.from({ length: read16(ifd) }, (_, i) => ifd + 2 + i * 12).find((offset) => read16(offset) === 0x8825);
    expect(gpsEntry).toBeDefined();
    const gps = read32(gpsEntry! + 8);
    const gpsTags = Array.from({ length: read16(gps) }, (_, i) => read16(gps + 2 + i * 12));
    expect(gpsTags).toEqual(expect.arrayContaining([1, 2, 3, 4]));
    expect(original.xmp).toBeDefined();
    expect(original.icc).toBeDefined();
    const output = await sharp(await reencodePhoto(input)).metadata();
    expect([output.width, output.height]).toEqual([40, 80]);
    expect(output.orientation).toBeUndefined();
    expect(output.exif).toBeUndefined();
    expect(output.xmp).toBeUndefined();
    expect(output.icc).toBeUndefined();
    expect(output.space).toBe("srgb");
  });
  it("does not enlarge a small image", async () => {
    const output = await sharp(await reencodePhoto(await image(12, 7).png().toBuffer())).metadata();
    expect([output.width, output.height]).toEqual([12, 7]);
  });
  it.each([
    { label: "text", bytes: () => Promise.resolve(Buffer.from("untrusted file detail")) },
    { label: "SVG", bytes: () => Promise.resolve(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>')) },
    { label: "GIF", bytes: () => image(10, 10).gif().toBuffer() },
    { label: "TIFF", bytes: () => image(10, 10).tiff().toBuffer() },
  ])("rejects $label with a fixed private error", async ({ bytes }) => {
    await expect(reencodePhoto(await bytes())).rejects.toThrow(/^Photo rejected$/);
  });
  it("rejects animated WebP rather than silently taking its first frame", async () => {
    // Different frames prevent the encoder from coalescing this into one frame.
    const pixels = Buffer.concat([Buffer.alloc(10 * 10 * 3, 0), Buffer.alloc(10 * 10 * 3, 255)]);
    const input = await sharp(pixels, { raw: { width: 10, height: 20, channels: 3, pageHeight: 10 } })
      .webp({ loop: 0, delay: [100, 100] }).toBuffer();
    expect((await sharp(input).metadata()).pages).toBe(2);
    await expect(reencodePhoto(input)).rejects.toThrow(/^Photo rejected$/);
  });
  it("rejects a valid two-frame APNG even when sharp does not report pages", async () => {
    const first = await image(10, 10).png().toBuffer();
    const second = await image(10, 10).negate().png().toBuffer();
    const firstChunks = pngChunks(first);
    const secondChunks = pngChunks(second);
    const animation = Buffer.alloc(8);
    animation.writeUInt32BE(2); // num_frames; num_plays=0 means infinite looping.
    const frameControl = (sequence: number) => {
      const control = Buffer.alloc(26);
      control.writeUInt32BE(sequence);
      control.writeUInt32BE(10, 4);
      control.writeUInt32BE(10, 8);
      control.writeUInt16BE(1, 20);
      control.writeUInt16BE(10, 22);
      return pngChunk("fcTL", control);
    };
    const sequence = Buffer.alloc(4);
    sequence.writeUInt32BE(2);
    const input = Buffer.concat([
      first.subarray(0, 8),
      pngChunk("IHDR", firstChunks.find(({ type }) => type === "IHDR")!.data),
      pngChunk("acTL", animation), frameControl(0),
      ...firstChunks.filter(({ type }) => type === "IDAT").map(({ data }) => pngChunk("IDAT", data)),
      frameControl(1),
      pngChunk("fdAT", Buffer.concat([sequence, ...secondChunks.filter(({ type }) => type === "IDAT").map(({ data }) => data)])),
      pngChunk("IEND", Buffer.alloc(0)),
    ]);
    // Every chunk has its proper CRC; sharp successfully decodes the fallback frame.
    const metadata = await sharp(input).metadata();
    expect(metadata.format).toBe("png");
    expect(metadata.pages).toBeUndefined();
    expect(await sharp(input).raw().toBuffer()).toEqual(await sharp(first).raw().toBuffer());
    await expect(reencodePhoto(input)).rejects.toThrow(/^Photo rejected$/);
  });
  it("accepts a static PNG containing acTL text inside an ancillary chunk", async () => {
    const original = await image(10, 10).png().toBuffer();
    const input = Buffer.concat([
      original.subarray(0, 8),
      ...pngChunks(original).flatMap(({ type, data }) => type === "IEND"
        ? [pngChunk("tEXt", Buffer.from("Comment\0acTL is text, not an animation chunk")), pngChunk(type, data)]
        : [pngChunk(type, data)]),
    ]);
    expect((await sharp(await reencodePhoto(input)).metadata()).format).toBe("webp");
  });
  it("rejects an image over 40 megapixels at the decoder boundary", async () => {
    const input = await image(6400, 6251).png().toBuffer();
    expect((await sharp(input).metadata()).width * (await sharp(input).metadata()).height).toBeGreaterThan(40_000_000);
    await expect(reencodePhoto(input)).rejects.toThrow(/^Photo rejected$/);
  });
});
