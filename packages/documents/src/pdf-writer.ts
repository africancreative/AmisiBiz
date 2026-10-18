import { roundDecimalString } from "./money";
import type { DocumentPdfRenderRequest, PdfImage } from "./pdf";
import type { DocumentSnapshot, SnapshotLine } from "./snapshot";
import type { DocumentType } from "./series";

/**
 * A dependency-free PDF writer and the commercial-document template.
 *
 * Why hand-rolled: the product prints quotations, invoices and delivery notes on
 * a device that may have no native PDF library and in a serverless function that
 * ships no headless browser. A ~40 KB of text layout code that emits a valid PDF
 * from the frozen snapshot is smaller, faster and more testable than either
 * alternative, and it keeps the document-integrity rule intact: the renderer
 * reads ONLY the snapshot.
 *
 * It is pure — no `Buffer`, no `zlib`, no DOM — so it runs on the server, in a
 * unit test and, later, inside the offline client. A caller embedding a PNG
 * decodes it to raw RGB first (that needs an inflate, which is a platform
 * concern); a JPEG is embedded untouched with `/DCTDecode`.
 *
 * The template is A4, paginates long item tables, repeats the table header on
 * each page, numbers every page, and paints the tenant's colours and logo. It
 * labels the document by what it IS. It never claims to be a KRA/eTIMS tax
 * invoice.
 */

/* --------------------------------- Geometry -------------------------------- */

const PAGE_WIDTH = 595.28; // A4 portrait, points
const PAGE_HEIGHT = 841.89;
const MARGIN_X = 42;
const MARGIN_TOP = 40;
const MARGIN_BOTTOM = 52;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN_X * 2;
const CONTENT_BOTTOM = PAGE_HEIGHT - MARGIN_BOTTOM;

/* ---------------------------------- Fonts ---------------------------------- */

// Standard-14 font metrics (units per 1000 em) for the printable ASCII range
// (char codes 32..126). Embedded so text can be measured, wrapped and
// right-aligned without guessing.
const HELVETICA_WIDTHS: readonly number[] = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278,
  278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584,
  584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556,
  833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278,
  278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222,
  500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500,
  500, 334, 260, 334, 584,
];

const HELVETICA_BOLD_WIDTHS: readonly number[] = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278,
  278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584,
  584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611,
  833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333,
  278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278,
  556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556,
  500, 389, 280, 389, 584,
];

type FontName = "F1" | "F2";

function charWidth(units: readonly number[], code: number): number {
  if (code >= 32 && code <= 126) return units[code - 32] ?? 556;
  return 556; // width of "?" — a reasonable stand-in for an unmapped glyph
}

function measureText(text: string, font: FontName, size: number): number {
  const units = font === "F2" ? HELVETICA_BOLD_WIDTHS : HELVETICA_WIDTHS;
  let total = 0;
  for (const char of text) total += charWidth(units, char.codePointAt(0) ?? 0);
  return (total * size) / 1000;
}

/* ------------------------------ Text encoding ------------------------------ */

// WinAnsiEncoding remaps the 0x80..0x9F range onto typographic punctuation.
const UNICODE_TO_WINANSI: Record<number, number> = {
  0x20ac: 0x80, // €
  0x201a: 0x82,
  0x0192: 0x83,
  0x201e: 0x84,
  0x2026: 0x85, // …
  0x2020: 0x86,
  0x2021: 0x87,
  0x02c6: 0x88,
  0x2030: 0x89,
  0x0160: 0x8a,
  0x2039: 0x8b,
  0x0152: 0x8c,
  0x2018: 0x91, // ‘
  0x2019: 0x92, // ’
  0x201c: 0x93, // “
  0x201d: 0x94, // ”
  0x2013: 0x96, // –
  0x2014: 0x97, // —
  0x2122: 0x99, // ™
  0x00a0: 0x20, // non-breaking space
};

function toWinAnsi(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 0x0a) {
      out += " ";
      continue;
    }
    if (code < 0x80) {
      out += char;
      continue;
    }
    if (code >= 0x80 && code <= 0xff) {
      out += char;
      continue;
    }
    const mapped = UNICODE_TO_WINANSI[code];
    out += mapped === undefined ? "?" : String.fromCharCode(mapped);
  }
  return out;
}

/** Escapes a string for a PDF literal `( … )` text operator. */
function pdfText(text: string): string {
  const winansi = toWinAnsi(text);
  let out = "";
  for (const char of winansi) {
    if (char === "\\" || char === "(" || char === ")") out += `\\${char}`;
    else out += char;
  }
  return out;
}

function encodeLatin1(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) {
    bytes[i] = text.charCodeAt(i) & 0xff;
  }
  return bytes;
}

/* --------------------------------- Wrapping -------------------------------- */

function wrapText(
  text: string,
  font: FontName,
  size: number,
  maxWidth: number,
): string[] {
  const paragraphs = text.split(/\r?\n/);
  const lines: string[] = [];

  for (const paragraph of paragraphs) {
    const words = paragraph.split(/\s+/).filter((word) => word.length > 0);
    if (words.length === 0) {
      lines.push("");
      continue;
    }
    let current = "";
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (measureText(candidate, font, size) <= maxWidth || current === "") {
        current = candidate;
      } else {
        lines.push(current);
        current = word;
      }
    }
    if (current) lines.push(current);
  }

  return lines.length > 0 ? lines : [""];
}

/* --------------------------------- Colours --------------------------------- */

type Rgb = { r: number; g: number; b: number };

const FALLBACK: Rgb = { r: 0.11, g: 0.31, b: 0.85 };

function parseHexColour(hex: string | null | undefined): Rgb {
  if (typeof hex !== "string") return FALLBACK;
  const match = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!match) return FALLBACK;
  const value = Number.parseInt(match[1] ?? "000000", 16);
  return {
    r: ((value >> 16) & 255) / 255,
    g: ((value >> 8) & 255) / 255,
    b: (value & 255) / 255,
  };
}

function fillOp(colour: Rgb): string {
  return `${colour.r.toFixed(4)} ${colour.g.toFixed(4)} ${colour.b.toFixed(4)} rg`;
}

function strokeOp(colour: Rgb): string {
  return `${colour.r.toFixed(4)} ${colour.g.toFixed(4)} ${colour.b.toFixed(4)} RG`;
}

/* ------------------------------- Formatting -------------------------------- */

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function formatIsoDate(iso: string | null): string {
  if (!iso) return "—";
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!match) return iso;
  const month = MONTHS[Number(match[2]) - 1] ?? "";
  return `${Number(match[3])} ${month} ${match[1]}`;
}

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** A plain grouped amount, no currency prefix (the currency is labelled once). */
function formatAmount(value: string, decimals = 2): string {
  const rounded = roundDecimalString(value, decimals);
  if (rounded === null) return value;
  const negative = rounded.startsWith("-");
  const unsigned = negative ? rounded.slice(1) : rounded;
  const [intPart = "0", fracPart = ""] = unsigned.split(".");
  return `${negative ? "-" : ""}${groupThousands(intPart)}${
    fracPart ? `.${fracPart}` : ""
  }`;
}

function formatQuantity(value: string): string {
  const rounded = roundDecimalString(value, 4);
  if (rounded === null) return value;
  return rounded.replace(/\.?0+$/, "") || "0";
}

/* ----------------------------- Low-level writer ---------------------------- */

type PdfObject = { head: string } | { head: string; stream: Uint8Array };

class PdfDocument {
  private readonly objects: PdfObject[] = [];

  /** Adds a dictionary-only object and returns its 1-based object number. */
  addObject(head: string): number {
    this.objects.push({ head });
    return this.objects.length;
  }

  /** Adds a stream object (content stream or image) and returns its number. */
  addStream(head: string, stream: Uint8Array): number {
    this.objects.push({ head, stream });
    return this.objects.length;
  }

  /** Replaces a dictionary-only object body, keeping its number and order. */
  replaceObject(id: number, head: string): void {
    const index = id - 1;
    if (this.objects[index]) this.objects[index] = { head };
  }

  /** Serialises the file. `root` is the /Catalog object number. */
  toUint8Array(root: number): Uint8Array {
    const chunks: Uint8Array[] = [];
    let length = 0;

    const push = (bytes: Uint8Array): void => {
      chunks.push(bytes);
      length += bytes.length;
    };
    const pushText = (text: string): void => push(encodeLatin1(text));

    pushText("%PDF-1.4\n");
    push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

    const offsets: number[] = [];
    for (let i = 0; i < this.objects.length; i += 1) {
      const object = this.objects[i];
      if (!object) continue;
      offsets[i] = length;
      pushText(`${i + 1} 0 obj\n${object.head}\n`);
      if ("stream" in object) {
        pushText("stream\n");
        push(object.stream);
        pushText("\nendstream\n");
      }
      pushText("endobj\n");
    }

    const xrefOffset = length;
    const size = this.objects.length + 1;
    let xref = `xref\n0 ${size}\n0000000000 65535 f \n`;
    for (let i = 0; i < this.objects.length; i += 1) {
      const offset = offsets[i] ?? 0;
      xref += `${String(offset).padStart(10, "0")} 00000 n \n`;
    }
    pushText(xref);
    pushText(
      `trailer\n<< /Size ${size} /Root ${root} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
    );

    const out = new Uint8Array(length);
    let cursor = 0;
    for (const chunk of chunks) {
      out.set(chunk, cursor);
      cursor += chunk.length;
    }
    return out;
  }
}

/** Reads width/height/component-count from a JPEG's SOF marker. */
function readJpegSize(data: Uint8Array): {
  width: number;
  height: number;
  components: number;
} | null {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < data.length) {
    if (data[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = data[offset + 1] ?? 0;
    // SOF0..SOF15 except DHT (c4), JPG (c8) and DAC (cc).
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    ) {
      const height = ((data[offset + 5] ?? 0) << 8) | (data[offset + 6] ?? 0);
      const width = ((data[offset + 7] ?? 0) << 8) | (data[offset + 8] ?? 0);
      const components = data[offset + 9] ?? 3;
      return { width, height, components };
    }
    const segmentLength =
      ((data[offset + 2] ?? 0) << 8) | (data[offset + 3] ?? 0);
    if (segmentLength < 2) return null;
    offset += 2 + segmentLength;
  }
  return null;
}

/* ------------------------------ Page builder ------------------------------- */

type TextOptions = {
  font?: FontName;
  size?: number;
  colour?: Rgb;
};

class PageBuilder {
  private readonly pages: string[] = [];
  private buffer = "";
  private cursorY = MARGIN_TOP;

  constructor(
    private readonly header: (pageIndex: number, builder: PageBuilder) => void,
    private readonly footer: (
      pageIndex: number,
      total: number,
      builder: PageBuilder,
    ) => void,
  ) {}

  /** Starts the first page and paints its header. */
  start(): void {
    this.newPage();
  }

  /** Begins a fresh page, flushing the current buffer. */
  newPage(): void {
    if (this.buffer) this.pages.push(this.buffer);
    this.buffer = "";
    this.cursorY = MARGIN_TOP;
    this.header(this.pages.length, this);
  }

  get y(): number {
    return this.cursorY;
  }
  set y(value: number) {
    this.cursorY = value;
  }

  /** True when `height` still fits above the bottom margin. */
  fits(height: number): boolean {
    return this.cursorY + height <= CONTENT_BOTTOM;
  }

  /** Moves to a new page when `height` would overflow. */
  ensure(height: number): void {
    if (!this.fits(height)) this.newPage();
  }

  moveDown(height: number): void {
    this.cursorY += height;
  }

  raw(ops: string): void {
    this.buffer += ops;
  }

  fillRect(x: number, y: number, w: number, h: number, colour: Rgb): void {
    const bottom = PAGE_HEIGHT - (y + h);
    this.buffer += `${fillOp(colour)} ${x.toFixed(2)} ${bottom.toFixed(
      2,
    )} ${w.toFixed(2)} ${h.toFixed(2)} re f\n`;
  }

  line(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    colour: Rgb,
    width = 0.6,
  ): void {
    this.buffer += `${strokeOp(colour)} ${width} w ${x1.toFixed(
      2,
    )} ${(PAGE_HEIGHT - y1).toFixed(2)} m ${x2.toFixed(2)} ${(
      PAGE_HEIGHT - y2
    ).toFixed(2)} l S\n`;
  }

  text(text: string, x: number, y: number, options: TextOptions = {}): void {
    const font = options.font ?? "F1";
    const size = options.size ?? 10;
    const colour = options.colour ?? { r: 0.1, g: 0.1, b: 0.1 };
    this.buffer += `BT /${font} ${size} Tf ${fillOp(colour)} 1 0 0 1 ${x.toFixed(
      2,
    )} ${(PAGE_HEIGHT - y).toFixed(2)} Tm (${pdfText(text)}) Tj ET\n`;
  }

  textRight(
    text: string,
    rightEdge: number,
    y: number,
    options: TextOptions = {},
  ): void {
    const width = measureText(text, options.font ?? "F1", options.size ?? 10);
    this.text(text, rightEdge - width, y, options);
  }

  image(name: string, x: number, y: number, w: number, h: number): void {
    const bottom = PAGE_HEIGHT - (y + h);
    this.buffer += `q ${w.toFixed(2)} 0 0 ${h.toFixed(2)} ${x.toFixed(
      2,
    )} ${bottom.toFixed(2)} cm /${name} Do Q\n`;
  }

  /** Flushes the last page and appends each page's footer, then returns all. */
  finish(): string[] {
    if (this.buffer) {
      this.pages.push(this.buffer);
      this.buffer = "";
    }
    const total = this.pages.length;
    for (let i = 0; i < total; i += 1) {
      this.buffer = "";
      this.footer(i, total, this);
      this.pages[i] = (this.pages[i] ?? "") + this.buffer;
    }
    this.buffer = "";
    return this.pages;
  }
}

/* --------------------------------- The template ----------------------------- */

const DOCUMENT_TITLES: Record<DocumentType, string> = {
  QUOTATION: "QUOTATION",
  INVOICE: "INVOICE",
  DELIVERY_NOTE: "DELIVERY NOTE",
  // An order is not a tax invoice — the template labels it plainly and the
  // constitution forbids any tax-invoice wording here.
  ORDER: "ORDER",
};

interface Column {
  key: "description" | "quantity" | "unitPrice" | "discount" | "tax" | "amount";
  label: string;
  width: number;
  align: "left" | "right";
}

const COLUMNS: readonly Column[] = [
  { key: "description", label: "Description", width: 211, align: "left" },
  { key: "quantity", label: "Qty", width: 44, align: "right" },
  { key: "unitPrice", label: "Unit price", width: 72, align: "right" },
  { key: "discount", label: "Discount", width: 58, align: "right" },
  { key: "tax", label: "Tax", width: 50, align: "right" },
  { key: "amount", label: "Amount", width: 76.28, align: "right" },
];

/** The x position of a column's left edge. */
function columnX(index: number): number {
  let x = MARGIN_X;
  for (let i = 0; i < index; i += 1) x += COLUMNS[i]?.width ?? 0;
  return x;
}

function lineTaxLabel(line: SnapshotLine): string {
  if (!line.taxRate || Number(line.taxRate) <= 0) return "—";
  return `${formatAmount(String((Number(line.taxRate) * 100).toFixed(2)), 2)}%`;
}

function discountLabel(line: SnapshotLine): string {
  if (line.discountType === "PERCENT" && Number(line.discountPercent) > 0) {
    return `${formatAmount(line.discountPercent, 2)}%`;
  }
  if (line.discountType === "AMOUNT" && Number(line.lineDiscount) > 0) {
    return formatAmount(line.lineDiscount, 2);
  }
  return "—";
}

/**
 * Renders a document to PDF bytes.
 *
 * Deterministic: the same request produces byte-identical output, which is what
 * lets a test assert on it and what a content hash on a filed document relies on.
 * The only non-determinism is the date passed in (`generatedAt` inside the
 * snapshot), which the caller controls.
 */
export function renderDocumentPdf(
  request: DocumentPdfRenderRequest,
): Uint8Array {
  const { model } = request;
  const branding = request.branding;
  const primary = parseHexColour(branding.primaryColor);
  const secondary = parseHexColour(branding.secondaryColor);
  const accent = parseHexColour(branding.accentColor);
  const ink: Rgb = { r: 0.12, g: 0.16, b: 0.22 };
  const muted: Rgb = { r: 0.42, g: 0.46, b: 0.52 };
  const hairline: Rgb = { r: 0.85, g: 0.87, b: 0.9 };
  const band: Rgb = { r: 0.96, g: 0.97, b: 0.98 };

  const title = DOCUMENT_TITLES[request.documentType];
  const currency = model.currency;

  const header = (pageIndex: number, builder: PageBuilder): void => {
    builder.fillRect(0, 0, PAGE_WIDTH, 6, primary);

    if (pageIndex === 0) {
      let y = MARGIN_TOP + 10;
      let textX = MARGIN_X;

      if (branding.logo) {
        const dims = imageSize(branding.logo);
        const logoHeight = 34;
        const logoWidth = Math.min(
          120,
          (dims.width / dims.height) * logoHeight || 60,
        );
        builder.image("Im0", MARGIN_X, y, logoWidth, logoHeight);
        textX = MARGIN_X + logoWidth + 12;
      }

      builder.text(
        branding.displayName || model.issuer.displayName || "Business",
        textX,
        y + 10,
        { font: "F2", size: 14, colour: primary },
      );
      let metaY = y + 24;
      const issuerLines = issuerBlockLines(model);
      for (const line of issuerLines) {
        builder.text(line, textX, metaY, { size: 8.5, colour: muted });
        metaY += 11;
      }

      // Title block, right aligned.
      builder.textRight(title, PAGE_WIDTH - MARGIN_X, y + 8, {
        font: "F2",
        size: 22,
        colour: secondary,
      });
      builder.textRight(model.number, PAGE_WIDTH - MARGIN_X, y + 26, {
        font: "F2",
        size: 11,
        colour: ink,
      });

      y = Math.max(metaY, y + 34) + 6;
      builder.line(MARGIN_X, y, PAGE_WIDTH - MARGIN_X, y, hairline, 0.8);
      builder.y = y + 14;
      return;
    }

    // Continuation pages get a slim band so the reader never loses the thread.
    builder.text(`${title} — ${model.number}`, MARGIN_X, MARGIN_TOP + 8, {
      font: "F2",
      size: 10,
      colour: secondary,
    });
    builder.textRight(
      branding.displayName || model.issuer.displayName,
      PAGE_WIDTH - MARGIN_X,
      MARGIN_TOP + 8,
      { size: 9, colour: muted },
    );
    builder.line(
      MARGIN_X,
      MARGIN_TOP + 14,
      PAGE_WIDTH - MARGIN_X,
      MARGIN_TOP + 14,
      hairline,
      0.6,
    );
    builder.y = MARGIN_TOP + 26;
  };

  const footer = (
    pageIndex: number,
    total: number,
    page: PageBuilder,
  ): void => {
    const y = PAGE_HEIGHT - MARGIN_BOTTOM + 24;
    page.line(MARGIN_X, y - 8, PAGE_WIDTH - MARGIN_X, y - 8, hairline, 0.5);
    page.text(
      `${branding.displayName || model.issuer.displayName} · ${currency}`,
      MARGIN_X,
      y + 2,
      { size: 7.5, colour: muted },
    );
    page.textRight(
      `Page ${pageIndex + 1} of ${total}`,
      PAGE_WIDTH - MARGIN_X,
      y + 2,
      { size: 7.5, colour: muted },
    );
  };

  const builder = new PageBuilder(header, footer);
  builder.start();

  // ── Dates & customer
  const partyY = builder.y;
  builder.text("BILL TO", MARGIN_X, partyY, {
    font: "F2",
    size: 8,
    colour: muted,
  });
  builder.text("DETAILS", PAGE_WIDTH - MARGIN_X - 150, partyY, {
    font: "F2",
    size: 8,
    colour: muted,
  });

  let leftY = partyY + 14;
  builder.text(model.customer.name, MARGIN_X, leftY, {
    font: "F2",
    size: 10.5,
    colour: ink,
  });
  leftY += 13;
  for (const line of customerBlockLines(model)) {
    builder.text(line, MARGIN_X, leftY, { size: 8.5, colour: muted });
    leftY += 11;
  }

  let rightY = partyY + 14;
  const rightX = PAGE_WIDTH - MARGIN_X - 150;
  const rightValueX = PAGE_WIDTH - MARGIN_X;
  const detailRows: Array<[string, string]> = [
    ["Issue date", formatIsoDate(model.issueDate)],
  ];
  if (model.dueDate)
    detailRows.push(["Due date", formatIsoDate(model.dueDate)]);
  if (model.expiryDate) {
    detailRows.push(["Valid until", formatIsoDate(model.expiryDate)]);
  }
  if (model.deliveryDate) {
    detailRows.push(["Delivery date", formatIsoDate(model.deliveryDate)]);
  }
  detailRows.push(["Currency", currency]);
  for (const [label, value] of detailRows) {
    builder.text(label, rightX, rightY, { size: 8.5, colour: muted });
    builder.textRight(value, rightValueX, rightY, {
      size: 8.5,
      colour: ink,
      font: "F2",
    });
    rightY += 12;
  }

  builder.y = Math.max(leftY, rightY) + 12;

  // ── Items table
  const drawTableHeader = (): void => {
    const height = 20;
    builder.ensure(height);
    const top = builder.y;
    builder.fillRect(MARGIN_X, top, CONTENT_WIDTH, height, band);
    COLUMNS.forEach((column, index) => {
      const x = columnX(index);
      const baseline = top + 13;
      if (column.align === "right") {
        builder.textRight(column.label, x + column.width - 6, baseline, {
          font: "F2",
          size: 8,
          colour: ink,
        });
      } else {
        builder.text(column.label, x + 6, baseline, {
          font: "F2",
          size: 8,
          colour: ink,
        });
      }
    });
    builder.y = top + height;
  };

  drawTableHeader();

  let rowIndex = 0;
  for (const line of model.lines) {
    const descriptionLines = wrapText(
      line.description,
      "F1",
      9,
      (COLUMNS[0]?.width ?? 200) - 12,
    );
    const rowHeight = Math.max(20, descriptionLines.length * 11 + 8);

    if (!builder.fits(rowHeight)) {
      builder.newPage();
      drawTableHeader();
    }

    const top = builder.y;
    if (rowIndex % 2 === 1) {
      builder.fillRect(MARGIN_X, top, CONTENT_WIDTH, rowHeight, band);
    }

    const firstBaseline = top + 13;
    descriptionLines.forEach((textLine, index) => {
      builder.text(textLine, MARGIN_X + 6, firstBaseline + index * 11, {
        size: 9,
        colour: ink,
      });
    });

    const codeBadge = line.itemCode
      ? `${line.itemCode} · ${line.unitOfMeasure}`
      : line.unitOfMeasure;
    if (codeBadge) {
      builder.text(
        codeBadge,
        MARGIN_X + 6,
        firstBaseline + descriptionLines.length * 11,
        { size: 7.5, colour: muted },
      );
    }

    const cells: Array<[number, string]> = [
      [1, formatQuantity(line.quantity)],
      [2, formatAmount(line.unitPrice)],
      [3, discountLabel(line)],
      [4, lineTaxLabel(line)],
      [5, formatAmount(line.lineTotal)],
    ];
    for (const [index, value] of cells) {
      const column = COLUMNS[index];
      if (!column) continue;
      builder.textRight(
        value,
        columnX(index) + column.width - 6,
        firstBaseline,
        { size: 9, colour: ink },
      );
    }

    builder.y = top + rowHeight;
    builder.line(
      MARGIN_X,
      builder.y,
      PAGE_WIDTH - MARGIN_X,
      builder.y,
      hairline,
      0.4,
    );
    rowIndex += 1;
  }

  // ── Totals
  const totalsRows: Array<[string, string, boolean]> = [
    ["Subtotal", formatAmount(model.subtotal), false],
  ];
  if (Number(model.totalDiscount) > 0) {
    totalsRows.push([
      "Discount",
      `- ${formatAmount(model.totalDiscount)}`,
      false,
    ]);
  }
  totalsRows.push(["Taxable base", formatAmount(model.taxableBase), false]);
  for (const entry of model.taxBreakdown) {
    if (Number(entry.amount) === 0 && Number(entry.base) === 0) continue;
    const label =
      Number(entry.rate) > 0
        ? `${entry.name} (${formatAmount(
            String(Number(entry.rate) * 100),
            2,
          )}%)`
        : entry.name;
    totalsRows.push([label, formatAmount(entry.amount), false]);
  }
  totalsRows.push([`Total (${currency})`, formatAmount(model.total), true]);

  const totalsHeight = totalsRows.length * 14 + 10;
  builder.ensure(totalsHeight + 8);
  const totalsWidth = 250;
  const totalsX = PAGE_WIDTH - MARGIN_X - totalsWidth;
  let totalsY = builder.y + 10;

  for (const [label, value, emphasised] of totalsRows) {
    if (emphasised) {
      builder.fillRect(totalsX, totalsY - 10, totalsWidth, 20, primary);
      builder.text(label, totalsX + 8, totalsY + 3, {
        font: "F2",
        size: 10,
        colour: parseHexColour(branding.primaryForeground),
      });
      builder.textRight(value, PAGE_WIDTH - MARGIN_X - 8, totalsY + 3, {
        font: "F2",
        size: 10,
        colour: parseHexColour(branding.primaryForeground),
      });
      totalsY += 24;
    } else {
      builder.text(label, totalsX + 8, totalsY + 2, { size: 9, colour: muted });
      builder.textRight(value, PAGE_WIDTH - MARGIN_X - 8, totalsY + 2, {
        size: 9,
        colour: ink,
      });
      totalsY += 14;
    }
  }
  builder.y = totalsY + 6;

  // ── Payment instructions, terms, notes
  const paragraphs: Array<[string, string]> = [];
  if (model.paymentInstructions) {
    paragraphs.push(["Payment instructions", model.paymentInstructions]);
  }
  if (model.terms) paragraphs.push(["Terms", model.terms]);
  if (model.customerNote) paragraphs.push(["Notes", model.customerNote]);

  for (const [heading, body] of paragraphs) {
    const bodyLines = wrapText(body, "F1", 8.5, CONTENT_WIDTH);
    const blockHeight = 18 + bodyLines.length * 11;
    builder.ensure(blockHeight + 6);
    builder.moveDown(8);
    builder.text(heading.toUpperCase(), MARGIN_X, builder.y, {
      font: "F2",
      size: 8,
      colour: accent,
    });
    builder.moveDown(12);
    for (const textLine of bodyLines) {
      builder.text(textLine, MARGIN_X, builder.y, { size: 8.5, colour: muted });
      builder.moveDown(11);
    }
  }

  const pageStreams = builder.finish();

  // ── Assemble the PDF
  const doc = new PdfDocument();
  doc.addObject("<< /Type /Catalog /Pages 2 0 R >>");
  // Reserve the pages object now so its number is stable (2), matching the
  // catalog's /Pages reference written above.
  doc.addObject("<< /Type /Pages /Kids [] /Count 0 >>");
  doc.addObject(
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  );
  doc.addObject(
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
  );

  let imageName: number | null = null;
  if (branding.logo) {
    imageName = addImageObject(doc, branding.logo);
  }

  const resources = `<< /Font << /F1 3 0 R /F2 4 0 R >>${
    imageName ? ` /XObject << /Im0 ${imageName} 0 R >>` : ""
  } >>`;

  const pageNumbers: number[] = [];
  for (const stream of pageStreams) {
    const content = doc.addStream(
      `<< /Length ${encodeLatin1(stream).length} >>`,
      encodeLatin1(stream),
    );
    const page = doc.addObject(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources ${resources} /Contents ${content} 0 R >>`,
    );
    pageNumbers.push(page);
  }

  // Fill in the /Pages object that was reserved as object 2.
  const kids = pageNumbers.map((number) => `${number} 0 R`).join(" ");
  doc.replaceObject(
    2,
    `<< /Type /Pages /Kids [${kids}] /Count ${pageNumbers.length} >>`,
  );

  return doc.toUint8Array(1);
}

/** A tiny helper for sizing a logo from its intrinsic dimensions. */
function imageSize(image: PdfImage): { width: number; height: number } {
  if (image.kind === "rgb") {
    return { width: image.width, height: image.height };
  }
  return readJpegSize(image.data) ?? { width: 300, height: 100 };
}

function addImageObject(doc: PdfDocument, image: PdfImage): number {
  if (image.kind === "rgb") {
    const head = `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${image.data.length} >>`;
    return doc.addStream(head, image.data);
  }

  const size = readJpegSize(image.data) ?? {
    width: 300,
    height: 100,
    components: 3,
  };
  const colourSpace =
    size.components === 1
      ? "/DeviceGray"
      : size.components === 4
        ? "/DeviceCMYK"
        : "/DeviceRGB";
  const head = `<< /Type /XObject /Subtype /Image /Width ${size.width} /Height ${size.height} /ColorSpace ${colourSpace} /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.data.length} >>`;
  return doc.addStream(head, image.data);
}

function issuerBlockLines(model: DocumentSnapshot): string[] {
  const lines: string[] = [];
  if (model.issuer.registeredName) lines.push(model.issuer.registeredName);
  if (model.issuer.physicalAddress) lines.push(model.issuer.physicalAddress);
  if (model.issuer.postalAddress) lines.push(model.issuer.postalAddress);
  const contact = [model.issuer.contactPhone, model.issuer.contactEmail]
    .filter((value): value is string => Boolean(value))
    .join("  ·  ");
  if (contact) lines.push(contact);
  if (model.issuer.website) lines.push(model.issuer.website);
  if (model.issuer.taxPin) lines.push(`PIN: ${model.issuer.taxPin}`);
  return lines;
}

function customerBlockLines(model: DocumentSnapshot): string[] {
  const lines: string[] = [];
  if (model.customer.address) lines.push(model.customer.address);
  const contact = [model.customer.phone, model.customer.email]
    .filter((value): value is string => Boolean(value))
    .join("  ·  ");
  if (contact) lines.push(contact);
  if (model.customer.taxPin) lines.push(`PIN: ${model.customer.taxPin}`);
  return lines;
}
