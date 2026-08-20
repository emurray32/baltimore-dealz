// PDF extract instrument for scripts/check-sources.mjs.
// Synthetic fixtures only — no live venue menus.

import test from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { extractPdfText } from "../scripts/check-sources.mjs";

const execFileAsync = promisify(execFile);

function hasBin(name) {
  try {
    execFileSync("which", [name], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const HAS_PDF_TOOLS = hasBin("pdftoppm") && hasBin("tesseract") && hasBin("pdftotext");
const OCR_TIMEOUT_MS = 60_000;

function buildPdf(objectBodies) {
  const out = [Buffer.from("%PDF-1.4\n")];
  let offset = out[0].length;
  const offsets = [];
  for (let i = 0; i < objectBodies.length; i += 1) {
    offsets.push(offset);
    const chunk = Buffer.concat([
      Buffer.from(`${i + 1} 0 obj\n`),
      objectBodies[i],
      Buffer.from("\nendobj\n"),
    ]);
    out.push(chunk);
    offset += chunk.length;
  }
  const xrefStart = offset;
  const xrefLines = [`xref\n0 ${objectBodies.length + 1}\n`, "0000000000 65535 f \n"];
  for (const off of offsets) {
    xrefLines.push(`${String(off).padStart(10, "0")} 00000 n \n`);
  }
  const xref = Buffer.from(xrefLines.join(""));
  out.push(xref);
  out.push(
    Buffer.from(
      `trailer << /Size ${objectBodies.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`,
    ),
  );
  return Buffer.concat(out);
}

function streamObj(contents) {
  const data = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
  return Buffer.concat([
    Buffer.from(`<< /Length ${data.length} >> stream\n`),
    data,
    Buffer.from("endstream"),
  ]);
}

/** One-page text PDF. */
function textLayerPdf(contentStream) {
  return buildPdf([
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    Buffer.from(
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    ),
    streamObj(contentStream),
    Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
  ]);
}

/**
 * Two-column menu whose pdftotext -layout pairs left-col dishes with right-col
 * prices on the same line. Tesseract (default PSM) reads down each column.
 */
function twoColumnMenuPdf() {
  const left = ["WINGS", "$7", "FRIES", "$4", "RINGS", "$5", "SLIDERS", "$9"];
  const right = ["NACHOS", "$12", "TACOS", "$11", "PRETZEL", "$8", "QUESO", "$15"];
  const leftX = 72;
  const rightX = 420;
  const top = 720;
  const leading = 22;
  const ops = [];
  for (let i = 0; i < left.length; i += 1) {
    const y = top - i * leading;
    ops.push(`BT /F1 14 Tf 1 0 0 1 ${leftX} ${y} Tm (${left[i]}) Tj ET\n`);
  }
  for (let i = 0; i < right.length; i += 1) {
    const y = top - i * leading;
    ops.push(`BT /F1 14 Tf 1 0 0 1 ${rightX} ${y} Tm (${right[i]}) Tj ET\n`);
  }
  return textLayerPdf(ops.join(""));
}

function jpegSize(buf) {
  let i = 0;
  while (i < buf.length - 8) {
    if (buf[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = buf[i + 1];
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      return {
        height: (buf[i + 5] << 8) | buf[i + 6],
        width: (buf[i + 7] << 8) | buf[i + 8],
      };
    }
    if (
      marker === 0xd8 ||
      marker === 0xd9 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      i += 2;
      continue;
    }
    const seglen = (buf[i + 2] << 8) | buf[i + 3];
    i += 2 + seglen;
  }
  throw new Error("jpeg SOF not found");
}

/** Rasterize a text-layer PDF and wrap the JPEG so pdftotext has no text layer. */
async function imageOnlyPdfFromText(contentStream) {
  const textPdf = textLayerPdf(contentStream);
  const dir = await mkdtemp(join(tmpdir(), "bd-fix-"));
  try {
    const pdfPath = join(dir, "in.pdf");
    await writeFile(pdfPath, textPdf);
    const prefix = join(dir, "page");
    await execFileAsync("pdftoppm", ["-jpeg", "-r", "150", pdfPath, prefix], {
      timeout: OCR_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    });
    const jpeg = await readFile(`${prefix}-1.jpg`);
    const { width, height } = jpegSize(jpeg);
    const imgObj = Buffer.concat([
      Buffer.from(
        `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >> stream\n`,
      ),
      jpeg,
      Buffer.from("endstream"),
    ]);
    const content = Buffer.from("q 612 0 0 792 0 0 cm /Im0 Do Q\n");
    return buildPdf([
      Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
      Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
      Buffer.from(
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>",
      ),
      streamObj(content),
      imgObj,
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function pdftotextLayout(buf) {
  const dir = await mkdtemp(join(tmpdir(), "bd-txt-"));
  try {
    const pdfPath = join(dir, "in.pdf");
    await writeFile(pdfPath, buf);
    const { stdout } = await execFileAsync("pdftotext", ["-layout", pdfPath, "-"], {
      timeout: OCR_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const SAME_LINE_INTERLEAVE = /WINGS[^\n]*NACHOS/;

test("image-only PDF: pdftotext empty, OCR recovers $ price + word", { skip: !HAS_PDF_TOOLS, timeout: OCR_TIMEOUT_MS }, async () => {
  const buf = await imageOnlyPdfFromText("BT /F1 36 Tf 72 700 Td (WINGS $8) Tj ET\n");
  const layout = await pdftotextLayout(buf);
  assert.equal(layout.trim(), "", "fixture is not image-only — pdftotext found a text layer");

  const extracted = await extractPdfText(buf);
  assert.equal(extracted.instrument, "ocr");
  assert.equal(extracted.error, undefined);
  const blob = String(extracted.text);
  assert.match(blob, /\$8/);
  assert.match(blob, /WINGS/i);
});

test("two-column PDF: OCR must not accept pdftotext's interleaved pairing", { skip: !HAS_PDF_TOOLS, timeout: OCR_TIMEOUT_MS }, async () => {
  const buf = twoColumnMenuPdf();
  const layout = await pdftotextLayout(buf);
  assert.match(
    layout,
    SAME_LINE_INTERLEAVE,
    "fixture does not trigger pdftotext -layout interleave — test proves nothing",
  );

  const extracted = await extractPdfText(buf);
  assert.equal(
    extracted.instrument,
    "ocr",
    "mutation: pdftotext-only extract on the column fixture must fail this suite",
  );
  assert.doesNotMatch(
    extracted.text,
    SAME_LINE_INTERLEAVE,
    "OCR blob accepted the interleaved WINGS…NACHOS pairing",
  );
  assert.match(extracted.text, /WINGS/i);
  assert.match(extracted.text, /\$7/);
});

test("column fixture mutation: helper text is not pdftotext -layout", { skip: !HAS_PDF_TOOLS, timeout: OCR_TIMEOUT_MS }, async () => {
  const buf = twoColumnMenuPdf();
  const layout = await pdftotextLayout(buf);
  const extracted = await extractPdfText(buf);
  const extractNorm = String(extracted.text).replace(/\s+/g, " ").trim();
  const layoutNorm = String(layout).replace(/\s+/g, " ").trim();
  assert.notEqual(
    extractNorm,
    layoutNorm,
    "mutation: extract equals pdftotext -layout — OCR is not the primary blob",
  );
  assert.notEqual(extracted.instrument, "pdftotext");
  assert.notEqual(extracted.instrument, "none");
});

test("both instruments fail → empty text + error (caller treats as UNKNOWN)", { timeout: 20_000 }, async () => {
  const extracted = await extractPdfText(Buffer.from("this is not a pdf"));
  assert.equal(String(extracted.text ?? "").trim(), "");
  assert.ok(extracted.error, "expected extract error when pdftoppm and pdftotext both fail");
  assert.equal(extracted.instrument, "none");
  // checkVenue maps extracted.error && !extracted.text to ok:false → UNKNOWN, never MISMATCH.
  assert.ok(extracted.error && !extracted.text);
});
