#!/usr/bin/env node
/**
 * Source monitor — does the source still say what we say it says?
 *
 * For every showable venue: fetch the verifying source_url(s), extract text,
 * and report how many published *prices* still appear (fixed-string match of
 * price token + a distinctive word from the item text).
 *
 * Not part of `npm test` — hits the live network (~35 venues).
 *
 * Ticket: Lead 2026-08-07. Matching deliberately avoids regex so `$` is never
 * an end-of-line anchor (that bug produced three wrong answers the same day).
 */

import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import { loadVenues } from "../src/venues.js";
import { hasShowableDeal, isDealRenderable } from "../src/deals.js";

const execFileAsync = promisify(execFile);

const TIMEOUT_MS = 20_000;
const USER_AGENT =
  "BaltimoreDealzSourceCheck/1.0 (+https://github.com/emurray32/baltimore-dealz; check-sources)";
/** Peer-PDF age gap (days) that flags a static file as stale vs siblings on the same host. */
const PEER_STALE_DAYS = 180;
/**
 * Window (chars, on whitespace-stripped text) in which price + distinctive word
 * must co-occur. PDF menu layouts often put the dish name left and the price
 * ~200 chars later on the same block (measured on Order of the Ace).
 */
const NEAR_WINDOW = 250;

/**
 * Last hand-calibration of this instrument (Lead, 2026-08-07 run 2).
 * Update these numbers when you re-calibrate against hand-verified-good venues.
 * The tool still over-flags — a MISMATCH is a prompt to look, not proof the board is wrong.
 */
const CALIBRATION = {
  date: "2026-08-07",
  handVerifiedGood: 11,
  pass: 6,
  mismatch: 5,
};

const STOP = new Set(
  `a an the of and or for with on at to from by in is are was were be been being
   all day night only bar happy hour special specials house select local draft
   drafts beer beers wine wines cocktail cocktails food item items each ea
   off free until after before per pc oz each mon tue wed thu fri sat sun
   monday tuesday wednesday thursday friday saturday sunday`.split(/\s+/),
);

// --- normalisation (fixed-string only; never RegExp) -----------------------

export function normalizeText(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Remove every whitespace char — letter-spaced PDF text becomes matchable. */
export function stripAllWhitespace(s) {
  let out = "";
  for (const ch of String(s ?? "")) {
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f" || ch === "\v") {
      continue;
    }
    out += ch;
  }
  return out;
}

/** Pull a price token like `$10`, `$1.50`, `1/2 off` from item.price or text. */
export function priceToken(item) {
  if (typeof item?.price === "string" && item.price.trim() !== "") {
    return normalizeText(item.price);
  }
  const text = String(item?.text ?? "");
  // Manual scan for '$' digits — no regex (ticket rule).
  const idx = text.indexOf("$");
  if (idx === -1) return null;
  let end = idx + 1;
  while (end < text.length) {
    const ch = text[end];
    if ((ch >= "0" && ch <= "9") || ch === "." || ch === ",") end += 1;
    else break;
  }
  if (end === idx + 1) return null;
  return normalizeText(text.slice(idx, end));
}

/** Bare numeric part of a $ price ("$9" → "9", "$1.50" → "1.50"). Non-$ prices → null. */
export function barePriceNumber(price) {
  const p = stripAllWhitespace(normalizeText(price));
  if (!p.startsWith("$") || p.length < 2) return null;
  const bare = p.slice(1);
  // Must start with a digit.
  if (!(bare[0] >= "0" && bare[0] <= "9")) return null;
  return bare;
}

/** Candidate non-stop words from item text (longest first). */
export function distinctiveWords(itemText, price) {
  const norm = normalizeText(itemText);
  const priceN = price ? normalizeText(price) : "";
  const words = [];
  let buf = "";
  for (const ch of norm) {
    if ((ch >= "a" && ch <= "z") || ch === "'") {
      buf += ch;
    } else {
      if (buf) {
        words.push(buf);
        buf = "";
      }
    }
  }
  if (buf) words.push(buf);

  const seen = new Set();
  const out = [];
  for (const w of words) {
    if (w.length < 3) continue;
    if (STOP.has(w)) continue;
    if (priceN && priceN.includes(w)) continue;
    if (seen.has(w)) continue;
    seen.add(w);
    out.push(w);
  }
  out.sort((a, b) => b.length - a.length);
  return out;
}

/** Longest distinctive word (back-compat helper). */
export function distinctiveWord(itemText, price) {
  return distinctiveWords(itemText, price)[0] || null;
}

/**
 * Fixed-string match on whitespace-stripped text.
 *
 * Cause 1: letter-spaced PDFs (`$ 1 0`) — strip ALL whitespace before compare.
 * Cause 2: menus print `oysters 9` while we store `$9` — accept bare number only
 *          when the item's distinctive word is nearby (bare `9` alone is meaningless).
 */
export function itemFoundInSource(sourceText, item) {
  const price = priceToken(item);
  if (!price) return null; // unpriced — not counted
  const words = distinctiveWords(item.text, price).map((w) => stripAllWhitespace(w));

  const compact = stripAllWhitespace(normalizeText(sourceText));
  const priceC = stripAllWhitespace(price);

  const anyWordNear = (anchor) => {
    if (words.length === 0) return true;
    for (const w of words) {
      if (nearInCompact(compact, anchor, w)) return true;
    }
    return false;
  };
  const anyWordPresent = () => {
    if (words.length === 0) return true;
    for (const w of words) {
      if (includesFixed(compact, w)) return true;
    }
    return false;
  };

  // Path A: full price token (usually includes `$`) present after whitespace strip.
  if (includesFixed(compact, priceC)) {
    if (words.length === 0) return true;
    if (anyWordNear(priceC)) return true;
    // Layered PDFs can put the dish name far from the price glyph.
    if (anyWordPresent()) return true;
  }

  // Path B: bare number + a distinctive word nearby (menus that omit `$` on food).
  const bare = barePriceNumber(price);
  if (bare && words.length > 0 && includesBareNumber(compact, bare)) {
    for (const w of words) {
      if (nearBareWithWord(compact, bare, w)) return true;
    }
  }

  return false;
}

function includesFixed(haystack, needle) {
  if (!needle) return false;
  return haystack.indexOf(needle) !== -1;
}

/** True when needle appears with non-digit (and non-dot) neighbors — avoids `9` in `19`. */
function includesBareNumber(compact, bare) {
  let from = 0;
  while (from <= compact.length) {
    const at = compact.indexOf(bare, from);
    if (at === -1) return false;
    if (isBareNumberBoundary(compact, at, bare.length)) return true;
    from = at + 1;
  }
  return false;
}

function isBareNumberBoundary(compact, at, len) {
  const before = at > 0 ? compact[at - 1] : "";
  const after = at + len < compact.length ? compact[at + len] : "";
  const digitOrDot = (ch) => (ch >= "0" && ch <= "9") || ch === ".";
  // Reject if glued to another digit/dot. `$` before is fine (already handled by path A).
  if (digitOrDot(before)) return false;
  if (digitOrDot(after)) return false;
  return true;
}

function nearInCompact(compact, a, b) {
  let from = 0;
  while (from <= compact.length) {
    const at = compact.indexOf(a, from);
    if (at === -1) break;
    const start = Math.max(0, at - NEAR_WINDOW);
    const end = Math.min(compact.length, at + a.length + NEAR_WINDOW);
    if (includesFixed(compact.slice(start, end), b)) return true;
    from = at + 1;
  }
  return false;
}

function nearBareWithWord(compact, bare, wordC) {
  let from = 0;
  while (from <= compact.length) {
    const at = compact.indexOf(bare, from);
    if (at === -1) break;
    if (isBareNumberBoundary(compact, at, bare.length)) {
      const start = Math.max(0, at - NEAR_WINDOW);
      const end = Math.min(compact.length, at + bare.length + NEAR_WINDOW);
      if (includesFixed(compact.slice(start, end), wordC)) return true;
    }
    from = at + 1;
  }
  return false;
}

// --- fetch + extract -------------------------------------------------------

function isInstagramVenue(venue) {
  if (venue.source_type === "instagram_profile") return true;
  const url = venue.source_url ?? "";
  return url.includes("instagram.com") || url.includes("instagr.am");
}

function classifyUrl(url, contentType = "") {
  const u = (url || "").toLowerCase();
  const ct = (contentType || "").toLowerCase();
  if (ct.includes("pdf") || u.endsWith(".pdf") || u.includes(".pdf?")) return "pdf";
  if (
    ct.includes("image/") ||
    u.endsWith(".png") ||
    u.endsWith(".jpg") ||
    u.endsWith(".jpeg") ||
    u.endsWith(".webp") ||
    u.endsWith(".gif")
  ) {
    return "image";
  }
  return "html";
}

function htmlToText(html) {
  let s = String(html);
  // Strip scripts/styles by string scan (fixed, not clever).
  s = stripTagBlock(s, "script");
  s = stripTagBlock(s, "style");
  s = stripTagBlock(s, "noscript");
  // Drop tags.
  let out = "";
  let inTag = false;
  for (const ch of s) {
    if (ch === "<") {
      inTag = true;
      continue;
    }
    if (ch === ">") {
      inTag = false;
      out += " ";
      continue;
    }
    if (!inTag) out += ch;
  }
  return out
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function stripTagBlock(html, tag) {
  const open = `<${tag}`;
  const close = `</${tag}>`;
  let s = html;
  // Case-insensitive by lowercasing a scan copy for positions only — mutate original carefully.
  let lower = s.toLowerCase();
  let guard = 0;
  while (guard++ < 50) {
    const i = lower.indexOf(open);
    if (i === -1) break;
    const j = lower.indexOf(close, i);
    if (j === -1) {
      s = s.slice(0, i);
      break;
    }
    s = s.slice(0, i) + " " + s.slice(j + close.length);
    lower = s.toLowerCase();
  }
  return s;
}

async function extractText(buf, url, contentType) {
  const kind = classifyUrl(url, contentType);
  if (kind === "html") {
    const html = Buffer.from(buf).toString("utf8");
    return { kind, text: htmlToText(html), html };
  }

  const dir = await mkdtemp(join(tmpdir(), "bd-check-"));
  try {
    const ext = kind === "pdf" ? ".pdf" : guessImageExt(url, contentType);
    const path = join(dir, `source${ext}`);
    await writeFile(path, Buffer.from(buf));
    if (kind === "pdf") {
      try {
        const { stdout } = await execFileAsync("pdftotext", ["-layout", path, "-"], {
          maxBuffer: 8 * 1024 * 1024,
          timeout: TIMEOUT_MS,
        });
        return { kind, text: stdout };
      } catch (err) {
        return { kind, text: "", error: `pdftotext: ${err.message}` };
      }
    }
    // image → tesseract
    try {
      const { stdout } = await execFileAsync("tesseract", [path, "stdout"], {
        maxBuffer: 8 * 1024 * 1024,
        timeout: TIMEOUT_MS,
      });
      return { kind, text: stdout };
    } catch (err) {
      return { kind, text: "", error: `tesseract: ${err.message}` };
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Pull candidate image URLs from HTML for flyer OCR (cause 3).
 * Prefer happy-hour / specials / flyer / menu filenames; skip icons and trackers.
 */
export function candidateImageUrls(html, pageUrl) {
  const raw = String(html ?? "");
  const found = [];
  const seen = new Set();

  const push = (u) => {
    if (!u || seen.has(u)) return;
    const lower = u.toLowerCase();
    if (lower.startsWith("data:")) return;
    if (lower.includes("favicon") || lower.includes("logo") || lower.includes("icon")) return;
    if (lower.includes("sprite") || lower.includes("pixel") || lower.includes("tracking")) return;
    if (lower.includes("avatar") || lower.includes("gravatar")) return;
    // Prefer real image extensions or CDN image paths.
    const looksImage =
      lower.includes(".png") ||
      lower.includes(".jpg") ||
      lower.includes(".jpeg") ||
      lower.includes(".webp") ||
      lower.includes(".gif") ||
      lower.includes("/image") ||
      lower.includes("wp-content/uploads");
    if (!looksImage) return;
    seen.add(u);
    found.push(u);
  };

  // src="..." / src='...'
  let i = 0;
  const lower = raw.toLowerCase();
  while (i < lower.length) {
    const at = lower.indexOf("src=", i);
    if (at === -1) break;
    const q = raw[at + 4];
    if (q !== '"' && q !== "'") {
      i = at + 4;
      continue;
    }
    const end = raw.indexOf(q, at + 5);
    if (end === -1) break;
    push(resolveUrl(raw.slice(at + 5, end).trim(), pageUrl));
    i = end + 1;
  }

  // srcset="url size, url size"
  i = 0;
  while (i < lower.length) {
    const at = lower.indexOf("srcset=", i);
    if (at === -1) break;
    const q = raw[at + 7];
    if (q !== '"' && q !== "'") {
      i = at + 7;
      continue;
    }
    const end = raw.indexOf(q, at + 8);
    if (end === -1) break;
    const srcset = raw.slice(at + 8, end);
    for (const part of srcset.split(",")) {
      const urlPart = part.trim().split(/\s+/)[0];
      if (urlPart) push(resolveUrl(urlPart, pageUrl));
    }
    i = end + 1;
  }

  // Score: happy-hour-ish names first.
  const scored = found.map((u) => {
    const l = u.toLowerCase();
    let score = 0;
    if (l.includes("happy") || l.includes("hh")) score += 5;
    if (l.includes("special") || l.includes("specials")) score += 4;
    if (l.includes("flyer") || l.includes("menu")) score += 3;
    if (l.includes("hour")) score += 2;
    if (l.includes(".png") || l.includes(".jpg") || l.includes(".jpeg")) score += 1;
    return { u, score };
  });
  scored.sort((a, b) => b.score - a.score);
  // Cap: OCR is expensive; try top few.
  return scored.slice(0, 5).map((s) => s.u);
}

function resolveUrl(href, base) {
  try {
    return new URL(href, base).href;
  } catch {
    return null;
  }
}

async function ocrImageUrl(imageUrl, cache) {
  const key = `ocr:${imageUrl}`;
  if (cache.has(key)) return cache.get(key);
  const promise = (async () => {
    const fetched = await fetchSource(imageUrl);
    if (!fetched.ok) return { ok: false, reason: fetched.reason, url: imageUrl };
    const extracted = await extractText(fetched.buf, imageUrl, fetched.contentType || "image/png");
    if (extracted.error && !extracted.text) {
      return { ok: false, reason: extracted.error, url: imageUrl };
    }
    return { ok: true, text: extracted.text, url: imageUrl };
  })();
  cache.set(key, promise);
  return promise;
}

function guessImageExt(url, contentType) {
  const ct = (contentType || "").toLowerCase();
  if (ct.includes("png")) return ".png";
  if (ct.includes("jpeg") || ct.includes("jpg")) return ".jpg";
  if (ct.includes("webp")) return ".webp";
  const u = (url || "").toLowerCase();
  if (u.endsWith(".png")) return ".png";
  if (u.endsWith(".webp")) return ".webp";
  if (u.endsWith(".gif")) return ".gif";
  return ".jpg";
}

/**
 * Fetch a URL. 403 / 404 / 410 / 5xx / network → failure (UNKNOWN).
 * Unlike the link-check suite, a 403 is NOT success here — we cannot read the body.
 */
export async function fetchSource(url, { fetchImpl = fetch, timeoutMs = TIMEOUT_MS } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      redirect: "follow",
      signal: ac.signal,
      headers: {
        "user-agent": USER_AGENT,
        accept: "text/html,application/xhtml+xml,application/pdf,image/*,*/*;q=0.8",
      },
    });
    const status = res.status;
    // Hard fail statuses for *content* checks — 403 cannot be read.
    if (status === 403 || status === 401 || status === 404 || status === 410 || status >= 500) {
      try {
        await res.arrayBuffer();
      } catch {
        /* drain */
      }
      return {
        ok: false,
        url,
        status,
        reason: `HTTP ${status}`,
        lastModified: res.headers.get("last-modified"),
      };
    }
    if (status < 200 || status >= 300) {
      try {
        await res.arrayBuffer();
      } catch {
        /* drain */
      }
      return {
        ok: false,
        url,
        status,
        reason: `HTTP ${status}`,
        lastModified: res.headers.get("last-modified"),
      };
    }
    const buf = await res.arrayBuffer();
    const contentType = res.headers.get("content-type") || "";
    const lastModified = res.headers.get("last-modified");
    return {
      ok: true,
      url,
      status,
      buf,
      contentType,
      lastModified,
    };
  } catch (err) {
    const cause = err?.cause;
    const code = cause?.code || err?.code || err?.name || "fetch_error";
    const message = cause?.message || err?.message || String(err);
    return { ok: false, url, reason: `${code}: ${message}` };
  } finally {
    clearTimeout(timer);
  }
}

// --- per-venue check -------------------------------------------------------

function showableItems(venue) {
  const items = [];
  for (const deal of venue.deals ?? []) {
    if (!isDealRenderable(deal)) continue;
    const sourceUrl = deal.source_url || venue.source_url;
    for (const item of deal.items ?? []) {
      if (priceToken(item)) {
        items.push({ item, sourceUrl });
      }
    }
  }
  return items;
}

async function checkVenue(venue, cache) {
  if (isInstagramVenue(venue)) {
    return {
      id: venue.id,
      status: "UNCOVERED",
      detail: "instagram",
      found: 0,
      total: 0,
    };
  }

  const priced = showableItems(venue);
  if (priced.length === 0) {
    return {
      id: venue.id,
      status: "UNKNOWN",
      detail: "no priced items",
      found: 0,
      total: 0,
    };
  }

  // Fetch each unique verifying URL once (shared cache across venues).
  const byUrl = new Map();
  for (const row of priced) {
    const u = row.sourceUrl;
    if (!u) {
      byUrl.set(null, { ok: false, reason: "missing source_url" });
      continue;
    }
    if (!cache.has(u)) {
      cache.set(u, fetchSource(u));
    }
  }

  // Wait for the URLs this venue needs.
  const texts = new Map(); // url → { ok, normText, kind, lastModified, reason }
  for (const u of new Set(priced.map((r) => r.sourceUrl))) {
    if (!u) {
      texts.set(u, { ok: false, reason: "missing source_url" });
      continue;
    }
    const fetched = await cache.get(u);
    if (!fetched.ok) {
      texts.set(u, {
        ok: false,
        reason: fetched.reason,
        lastModified: fetched.lastModified ?? null,
        kind: classifyUrl(u, ""),
      });
      continue;
    }
    const extracted = await extractText(fetched.buf, u, fetched.contentType);
    if (extracted.error && !extracted.text) {
      texts.set(u, {
        ok: false,
        reason: extracted.error,
        lastModified: fetched.lastModified ?? null,
        kind: extracted.kind,
      });
      continue;
    }
    texts.set(u, {
      ok: true,
      // Keep original extract for matching (itemFoundInSource strips whitespace itself).
      text: extracted.text,
      html: extracted.html ?? null,
      kind: extracted.kind,
      lastModified: fetched.lastModified ?? null,
      rawLen: extracted.text?.length ?? 0,
      pageUrl: u,
    });
  }

  // If every URL failed → UNKNOWN. If some failed, count those items as misses
  // only when we could not read their source — ticket: fetch failed never PASS.
  const anyOk = [...texts.values()].some((t) => t.ok);
  if (!anyOk) {
    const reason = [...texts.values()][0]?.reason || "fetch failed";
    return {
      id: venue.id,
      status: "UNKNOWN",
      detail: reason,
      found: 0,
      total: priced.length,
      pdfMeta: collectPdfMeta(texts),
    };
  }

  const scoreItems = (textByUrl) => {
    let found = 0;
    let total = 0;
    let unreadItems = 0;
    for (const row of priced) {
      total += 1;
      const t = textByUrl.get(row.sourceUrl);
      if (!t?.ok) {
        unreadItems += 1;
        continue;
      }
      if (itemFoundInSource(t.text, row.item)) found += 1;
    }
    return { found, total, unreadItems };
  };

  let { found, total, unreadItems } = scoreItems(texts);

  // Cause 3: HTML page with zero price matches → try flyer OCR before MISMATCH.
  let ocrNote = null;
  if (found === 0 && unreadItems === 0) {
    const htmlSources = [...texts.entries()].filter(([, t]) => t.ok && t.kind === "html" && t.html);
    if (htmlSources.length > 0) {
      let ocrTextParts = [];
      let triedImages = 0;
      let anyCandidate = false;
      for (const [pageUrl, t] of htmlSources) {
        const candidates = candidateImageUrls(t.html, pageUrl);
        if (candidates.length) anyCandidate = true;
        for (const imgUrl of candidates) {
          triedImages += 1;
          const ocr = await ocrImageUrl(imgUrl, cache);
          if (ocr.ok && ocr.text) ocrTextParts.push(ocr.text);
        }
      }
      if (ocrTextParts.length > 0) {
        const combined = ocrTextParts.join("\n");
        ocrNote = `ocr ${triedImages} image(s)`;
        // Re-score every item against page text + OCR text for its HTML source.
        found = 0;
        for (const row of priced) {
          const t = texts.get(row.sourceUrl);
          const base = t?.ok ? t.text : "";
          const blob = base + "\n" + combined;
          if (itemFoundInSource(blob, row.item)) found += 1;
        }
      } else if (anyCandidate) {
        // Images existed but OCR/fetch failed — cannot accuse the data.
        return {
          id: venue.id,
          status: "UNKNOWN",
          detail: "prices not in page text; image OCR failed",
          found: 0,
          total,
          pdfMeta: collectPdfMeta(texts),
        };
      } else {
        // No candidate image on HTML page — not a MISMATCH.
        return {
          id: venue.id,
          status: "UNKNOWN",
          detail: "prices not in page text",
          found: 0,
          total,
          pdfMeta: collectPdfMeta(texts),
        };
      }
    }
  }

  // If we could not read the source for every item, treat as UNKNOWN when
  // zero were readable for this venue (already handled). Ticket: fetch failed →
  // UNKNOWN, never PASS. If any fetch failed for this venue's items, never PASS.
  let status;
  let detail = `${found}/${total}`;
  if (ocrNote) detail += ` (${ocrNote})`;
  if (unreadItems > 0) {
    status = "UNKNOWN";
    detail = `fetch failed for ${unreadItems}/${total} items; matched ${found}/${total - unreadItems} readable`;
  } else if (found === total) {
    status = "PASS";
  } else if (found === 0) {
    // Non-HTML zero-match (PDF/image) still reports MISMATCH — the source was readable.
    status = "MISMATCH";
  } else {
    status = "MISMATCH";
  }

  return {
    id: venue.id,
    status,
    detail,
    found,
    total,
    pdfMeta: collectPdfMeta(texts),
  };
}

function collectPdfMeta(texts) {
  const out = [];
  for (const [url, t] of texts) {
    if (!url || t.kind !== "pdf") continue;
    out.push({
      url,
      lastModified: t.lastModified ?? null,
      host: safeHost(url),
    });
  }
  return out;
}

function safeHost(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function parseHttpDate(s) {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

function peerStaleFlags(allPdfMeta) {
  // Group by host; flag any PDF whose Last-Modified is PEER_STALE_DAYS older
  // than the newest PDF we saw on that host in this run.
  const byHost = new Map();
  for (const m of allPdfMeta) {
    if (!m.host || !m.lastModified) continue;
    const list = byHost.get(m.host) ?? [];
    list.push(m);
    byHost.set(m.host, list);
  }
  const flags = [];
  for (const [host, list] of byHost) {
    if (list.length < 2) continue;
    const times = list
      .map((m) => ({ m, t: parseHttpDate(m.lastModified) }))
      .filter((x) => x.t != null);
    if (times.length < 2) continue;
    const newest = Math.max(...times.map((x) => x.t));
    for (const { m, t } of times) {
      const ageDays = (newest - t) / (24 * 60 * 60 * 1000);
      if (ageDays >= PEER_STALE_DAYS) {
        flags.push({
          host,
          url: m.url,
          lastModified: m.lastModified,
          daysBehindNewest: Math.round(ageDays),
        });
      }
    }
  }
  return flags;
}

// --- main ------------------------------------------------------------------

function formatLine(result) {
  if (result.status === "UNCOVERED") {
    return `${result.id}  UNCOVERED (instagram)`;
  }
  if (result.status === "UNKNOWN") {
    return `${result.id}  UNKNOWN (${result.detail})`;
  }
  return `${result.id}  ${result.status} ${result.detail}`;
}

async function main() {
  const venues = await loadVenues();
  const showable = venues.filter(hasShowableDeal).sort((a, b) => a.id.localeCompare(b.id));

  const cache = new Map(); // url → Promise
  const results = [];
  const allPdfMeta = [];

  // Sequential: polite to small venues; avoids parallel bot-rate spikes.
  for (const venue of showable) {
    const r = await checkVenue(venue, cache);
    results.push(r);
    if (r.pdfMeta) allPdfMeta.push(...r.pdfMeta.map((m) => ({ ...m, venueId: r.id })));
    console.log(formatLine(r));
  }

  const pass = results.filter((r) => r.status === "PASS").length;
  const mismatch = results.filter((r) => r.status === "MISMATCH").length;
  const unknown = results.filter((r) => r.status === "UNKNOWN").length;
  const uncovered = results.filter((r) => r.status === "UNCOVERED").length;
  const couldNotCheck = unknown + uncovered;

  console.log("");
  console.log("--- summary ---");
  console.log(`venues with showable deals : ${results.length}`);
  console.log(`PASS                       : ${pass}`);
  console.log(`MISMATCH                   : ${mismatch}`);
  console.log(`UNKNOWN (could not read)   : ${unknown}`);
  console.log(`UNCOVERED (instagram)      : ${uncovered}`);
  console.log(`could not check            : ${couldNotCheck} of ${results.length}`);
  console.log(
    `checked end-to-end          : ${pass + mismatch} of ${results.length}`,
  );
  console.log("");
  console.log("--- trust / how to read this ---");
  console.log(
    `Last hand-calibration (${CALIBRATION.date}): ${CALIBRATION.pass} PASS / ${CALIBRATION.mismatch} MISMATCH of ${CALIBRATION.handVerifiedGood} hand-verified-good venues.`,
  );
  console.log(
    "A MISMATCH is a prompt to look, not a finding that the board is wrong.",
  );
  console.log(
    "This instrument still over-flags (matching gaps, our shorthand vs source wording).",
  );

  // Second signal: static PDF Last-Modified peer gaps (header only, never filename).
  const flags = peerStaleFlags(allPdfMeta);
  const withLm = allPdfMeta.filter((m) => m.lastModified);
  console.log("");
  console.log("--- static PDF Last-Modified (header) ---");
  console.log(`PDF sources seen           : ${allPdfMeta.length}`);
  console.log(`with Last-Modified header  : ${withLm.length}`);
  for (const m of withLm) {
    console.log(`  ${m.venueId || "?"}  ${m.lastModified}  ${m.url}`);
  }
  if (flags.length) {
    console.log(`peer-stale flags (≥${PEER_STALE_DAYS}d behind newest on host):`);
    for (const f of flags) {
      console.log(
        `  ${f.host}  ${f.daysBehindNewest}d behind newest  ${f.lastModified}  ${f.url}`,
      );
    }
  } else {
    console.log(
      `peer-stale flags (≥${PEER_STALE_DAYS}d behind newest on host): none this run`,
    );
  }

  // Exit 0 always for a report tool — mismatches are prompts to look, not CI red.
  // (Ticket: post the true state; do not join npm test.)
}

// Run when executed directly (path may be relative on argv).
const thisFile = fileURLToPath(import.meta.url);
const invoked = process.argv[1] ? join(process.cwd(), process.argv[1]) : "";
const isMain =
  process.argv[1] &&
  (thisFile === process.argv[1] || thisFile === invoked || thisFile.endsWith(process.argv[1]));

if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
