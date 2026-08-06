// Fetches every source_url in venues.json and fails on cert/DNS/dead pages.
// Catches the Smaltimore-class break (invalid TLS) before a customer sees it.
// Bot walls (Cloudflare 403 "Just a moment…") are not "dead" — browsers still
// open those pages; we only fail hard errors and 404/410/5xx.

import test from "node:test";
import assert from "node:assert/strict";
import { loadVenues } from "../src/venues.js";

const TIMEOUT_MS = 15_000;
const USER_AGENT =
  "BaltimoreDealzLinkCheck/1.0 (+https://github.com/emurray32/baltimore-dealz; source-url suite)";

// Collect unique source URLs from venues and deal rows, with provenance labels.
export function collectSourceUrls(venues) {
  const byUrl = new Map();
  for (const venue of venues) {
    if (typeof venue.source_url === "string" && venue.source_url !== "") {
      const list = byUrl.get(venue.source_url) ?? [];
      list.push(`${venue.id} (venue)`);
      byUrl.set(venue.source_url, list);
    }
    for (const deal of venue.deals ?? []) {
      if (typeof deal.source_url === "string" && deal.source_url !== "") {
        const list = byUrl.get(deal.source_url) ?? [];
        list.push(`${venue.id} (deal)`);
        byUrl.set(deal.source_url, list);
      }
    }
  }
  return byUrl;
}

function isHardHttpFailure(status) {
  // 404 / 410 = gone. 5xx = dead-ish from our side. 401/403 often mean a
  // working origin with bot/auth walls (Union Hill Cloudflare, some IG/FB).
  if (status === 404 || status === 410) return true;
  if (status >= 500) return true;
  return false;
}

export async function checkSourceUrl(url, { fetchImpl = fetch, timeoutMs = TIMEOUT_MS } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      redirect: "follow",
      signal: ac.signal,
      headers: {
        "user-agent": USER_AGENT,
        accept: "text/html,application/xhtml+xml,application/pdf,*/*;q=0.8",
      },
    });
    // Drain body so the socket can close cleanly; we do not parse HTML for
    // "profile unavailable" — that is a separate honesty problem.
    try {
      await res.arrayBuffer();
    } catch {
      // ignore body read errors once headers arrived
    }
    if (isHardHttpFailure(res.status)) {
      return { ok: false, url, reason: `HTTP ${res.status}` };
    }
    return { ok: true, url, status: res.status };
  } catch (err) {
    const cause = err?.cause;
    const code = cause?.code || err?.code || err?.name || "fetch_error";
    // Node's undici surfaces TLS problems as CERT_* / UNABLE_TO_VERIFY_*.
    const message = cause?.message || err?.message || String(err);
    return { ok: false, url, reason: `${code}: ${message}` };
  } finally {
    clearTimeout(timer);
  }
}

test("every source_url in venues.json is reachable (cert, DNS, 404, 5xx)", async () => {
  const venues = await loadVenues();
  const byUrl = collectSourceUrls(venues);
  assert.ok(byUrl.size > 0, "no source URLs in seed — test proves nothing");

  // Smaltimore must be http (https cert is broken). Pin the ticket fix.
  const smaltimore = venues.find((v) => v.id === "smaltimore");
  assert.ok(smaltimore?.source_url?.startsWith("http://"), "smaltimore must use http://");
  assert.ok(
    !smaltimore?.source_url?.startsWith("https://"),
    "smaltimore must not use https:// (broken cert)",
  );

  // Dead Tap House IG must not be linked.
  const tap = venues.find((v) => v.id === "baltimore-tap-house");
  assert.equal(tap?.source_url, undefined, "baltimore-tap-house must have no source_url");

  const failures = [];
  // Sequential: polite to small venues; avoids parallel bot-rate spikes.
  for (const [url, labels] of byUrl) {
    const result = await checkSourceUrl(url);
    if (!result.ok) {
      failures.push(`${url} ← ${labels.join(", ")} — ${result.reason}`);
    }
  }

  assert.equal(
    failures.length,
    0,
    failures.length
      ? `broken source URL(s):\n${failures.map((f) => `  - ${f}`).join("\n")}`
      : "",
  );
});

test("link checker treats certificate errors and 404 as failures", async () => {
  // Synthetic: a fetchImpl that throws a cert-shaped error, then a 404.
  const certBoom = async () => {
    const err = new Error("fetch failed");
    err.cause = Object.assign(new Error("certificate has expired"), {
      code: "CERT_HAS_EXPIRED",
    });
    throw err;
  };
  const cert = await checkSourceUrl("https://example.invalid/cert", { fetchImpl: certBoom });
  assert.equal(cert.ok, false);
  assert.match(cert.reason, /CERT_HAS_EXPIRED/);

  const notFound = await checkSourceUrl("https://example.invalid/404", {
    fetchImpl: async () =>
      new Response("", { status: 404, statusText: "Not Found" }),
  });
  assert.equal(notFound.ok, false);
  assert.match(notFound.reason, /HTTP 404/);

  // 403 alone is not a hard failure (Cloudflare / bot walls).
  const forbidden = await checkSourceUrl("https://example.invalid/403", {
    fetchImpl: async () => new Response("Just a moment...", { status: 403 }),
  });
  assert.equal(forbidden.ok, true);
  assert.equal(forbidden.status, 403);
});
