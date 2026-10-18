import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { inflateSync } from "node:zlib";
import type { PdfImage } from "@amisibiz/documents";

/**
 * Turns a tenant's stored logo into an image the PDF writer can embed.
 *
 * This is the one part of rendering that cannot be pure: a PNG has to be
 * inflated (`zlib`) and unfiltered before its pixels can be written into a PDF,
 * and that needs a platform. Everything downstream — layout, pagination, text —
 * stays in the dependency-free `@amisibiz/documents` writer.
 *
 * The logo path is never taken from user text. `logoUrl` is the value the upload
 * route wrote (`/uploads/tenants/<uuid>/logo/<file>`), and it is re-validated
 * here and resolved underneath the uploads root, so a forged path cannot read an
 * arbitrary file. A logo that cannot be decoded (WebP, a corrupt PNG, an
 * unsupported bit depth) returns null; the template then prints the business
 * name instead, which degrades cleanly rather than failing the download.
 */

const UPLOADS_ROOT = resolve(process.cwd(), "uploads");

/** Bounds so a hostile or accidental giant image cannot exhaust memory. */
const MAX_DIMENSION = 4000;
const MAX_PIXELS = 4_000_000;

const LOGO_PATH =
  /^\/?uploads\/((?:[a-z0-9][a-z0-9._-]*\/){3}[a-z0-9][a-z0-9._-]*)$/i;

function resolveLogoFile(logoUrl: string): string | null {
  const match = LOGO_PATH.exec(logoUrl.trim());
  if (!match) return null;
  const relative = match[1];
  if (!relative) return null;
  const candidate = resolve(UPLOADS_ROOT, relative);
  if (!candidate.startsWith(UPLOADS_ROOT + sep)) return null;
  return candidate;
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (
    (((bytes[offset] ?? 0) << 24) |
      ((bytes[offset + 1] ?? 0) << 16) |
      ((bytes[offset + 2] ?? 0) << 8) |
      (bytes[offset + 3] ?? 0)) >>>
    0
  );
}

/** Reads (optionally) the JPEG/PNG bytes for a stored logo URL. */
export async function loadLogoImage(
  logoUrl: string | null,
): Promise<PdfImage | null> {
  if (!logoUrl) return null;

  let buffer: Uint8Array;
  if (logoUrl.startsWith("http://") || logoUrl.startsWith("https://")) {
    try {
      const response = await fetch(logoUrl);
      if (!response.ok) return null;
      buffer = new Uint8Array(await response.arrayBuffer());
    } catch {
      return null;
    }
  } else {
    const file = resolveLogoFile(logoUrl);
    if (!file) return null;

    try {
      buffer = new Uint8Array(await readFile(file));
    } catch {
      return null;
    }
  }

  const lower = logoUrl.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) {
    return { kind: "jpeg", data: buffer };
  }
  if (lower.endsWith(".png")) {
    return decodePng(buffer);
  }
  // WebP and anything else are not embedded today; the name is printed instead.
  return null;
}

/** Decodes an 8-bit, non-interlaced PNG to raw RGB (alpha over white). */
export function decodePng(bytes: Uint8Array): PdfImage | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 8 || signature.some((b, i) => bytes[i] !== b)) return null;

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colourType = 0;
  let interlace = 0;
  let palette: Uint8Array | null = null;
  let transparency: Uint8Array | null = null;
  const idat: Uint8Array[] = [];

  while (offset + 8 <= bytes.length) {
    const length = readU32(bytes, offset);
    const type = String.fromCharCode(
      bytes[offset + 4] ?? 0,
      bytes[offset + 5] ?? 0,
      bytes[offset + 6] ?? 0,
      bytes[offset + 7] ?? 0,
    );
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > bytes.length) break;

    if (type === "IHDR") {
      width = readU32(bytes, dataStart);
      height = readU32(bytes, dataStart + 4);
      bitDepth = bytes[dataStart + 8] ?? 0;
      colourType = bytes[dataStart + 9] ?? 0;
      interlace = bytes[dataStart + 12] ?? 0;
    } else if (type === "PLTE") {
      palette = bytes.slice(dataStart, dataEnd);
    } else if (type === "tRNS") {
      transparency = bytes.slice(dataStart, dataEnd);
    } else if (type === "IDAT") {
      idat.push(bytes.slice(dataStart, dataEnd));
    } else if (type === "IEND") {
      break;
    }

    offset = dataEnd + 4; // skip the CRC
  }

  if (bitDepth !== 8 || interlace !== 0) return null;
  if (width <= 0 || height <= 0) return null;
  if (width > MAX_DIMENSION || height > MAX_DIMENSION) return null;
  if (width * height > MAX_PIXELS) return null;
  if (idat.length === 0) return null;

  const channels =
    colourType === 0
      ? 1
      : colourType === 2
        ? 3
        : colourType === 3
          ? 1
          : colourType === 4
            ? 2
            : colourType === 6
              ? 4
              : 0;
  if (channels === 0) return null;

  const compressed = concat(idat);
  let raw: Uint8Array;
  try {
    raw = new Uint8Array(inflateSync(compressed));
  } catch {
    return null;
  }

  const stride = width * channels;
  if (raw.length < (stride + 1) * height) return null;

  const pixels = unfilter(raw, width, height, channels, stride);
  const rgb = toRgb(
    pixels,
    width,
    height,
    channels,
    colourType,
    palette,
    transparency,
  );
  if (!rgb) return null;

  return { kind: "rgb", width, height, data: rgb };
}

function concat(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const chunk of chunks) {
    out.set(chunk, cursor);
    cursor += chunk.length;
  }
  return out;
}

/** Reverses the PNG per-scanline filters (types 0–4). */
function unfilter(
  raw: Uint8Array,
  width: number,
  height: number,
  channels: number,
  stride: number,
): Uint8Array {
  const out = new Uint8Array(stride * height);
  let source = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[source] ?? 0;
    source += 1;
    const rowStart = y * stride;
    const prevStart = (y - 1) * stride;
    for (let x = 0; x < stride; x += 1) {
      const rawByte = raw[source + x] ?? 0;
      const left = x >= channels ? (out[rowStart + x - channels] ?? 0) : 0;
      const up = y > 0 ? (out[prevStart + x] ?? 0) : 0;
      const upLeft =
        y > 0 && x >= channels ? (out[prevStart + x - channels] ?? 0) : 0;

      let value: number;
      if (filter === 0) value = rawByte;
      else if (filter === 1) value = rawByte + left;
      else if (filter === 2) value = rawByte + up;
      else if (filter === 3) value = rawByte + ((left + up) >> 1);
      else if (filter === 4) value = rawByte + paeth(left, up, upLeft);
      else value = rawByte;

      out[rowStart + x] = value & 0xff;
    }
    source += stride;
  }
  void width;
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function toRgb(
  pixels: Uint8Array,
  width: number,
  height: number,
  channels: number,
  colourType: number,
  palette: Uint8Array | null,
  transparency: Uint8Array | null,
): Uint8Array | null {
  const out = new Uint8Array(width * height * 3);
  const count = width * height;

  for (let i = 0; i < count; i += 1) {
    const source = i * channels;
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 255;

    if (colourType === 2) {
      r = pixels[source] ?? 0;
      g = pixels[source + 1] ?? 0;
      b = pixels[source + 2] ?? 0;
    } else if (colourType === 6) {
      r = pixels[source] ?? 0;
      g = pixels[source + 1] ?? 0;
      b = pixels[source + 2] ?? 0;
      a = pixels[source + 3] ?? 255;
    } else if (colourType === 0) {
      const grey = pixels[source] ?? 0;
      r = grey;
      g = grey;
      b = grey;
      if (transparency && transparency.length >= 2) {
        const key = ((transparency[0] ?? 0) << 8) | (transparency[1] ?? 0);
        if (grey === key) a = 0;
      }
    } else if (colourType === 4) {
      const grey = pixels[source] ?? 0;
      r = grey;
      g = grey;
      b = grey;
      a = pixels[source + 1] ?? 255;
    } else if (colourType === 3) {
      if (!palette) return null;
      const index = pixels[source] ?? 0;
      const base = index * 3;
      if (base + 2 >= palette.length) return null;
      r = palette[base] ?? 0;
      g = palette[base + 1] ?? 0;
      b = palette[base + 2] ?? 0;
      a =
        transparency && index < transparency.length
          ? (transparency[index] ?? 255)
          : 255;
    } else {
      return null;
    }

    const target = i * 3;
    if (a >= 255) {
      out[target] = r;
      out[target + 1] = g;
      out[target + 2] = b;
    } else {
      // Composite over white: a PDF DeviceRGB image has no alpha channel.
      out[target] = Math.round((r * a + 255 * (255 - a)) / 255);
      out[target + 1] = Math.round((g * a + 255 * (255 - a)) / 255);
      out[target + 2] = Math.round((b * a + 255 * (255 - a)) / 255);
    }
  }

  return out;
}
