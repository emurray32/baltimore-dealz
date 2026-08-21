// Request a spot box on every neighborhood board. Markup pins only — do not
// live-POST the Google Form from this file (Lead: one labeled prove submit
// from local npm start, not the suite).
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { renderBoard } from "../src/page.js";
import { venuesInView } from "../src/deals.js";
import { loadVenues } from "../src/venues.js";
import { loadViews } from "../src/views.js";

const FRI_11PM_EDT = new Date("2026-08-08T03:00:00Z");
const FORM_ACTION =
  "https://docs.google.com/forms/d/e/1FAIpQLSdTbRA2t8U-7R5NLf6FgVnNySmdvjb7i-zqDlWclwlF0EdbcA/formResponse";
const NAME_ENTRY = "entry.554747133";
const NOTE_ENTRY = "entry.813817545";
const META =
  "Know a Baltimore place with a weekly special we missed? Name it.";

function boardHtml(view, views, venues) {
  return renderBoard(venuesInView(venues, view), view, views, FRI_11PM_EDT);
}

function footerHtml(html) {
  const m = html.match(/<footer id="request-spot">[\s\S]*?<\/footer>/);
  assert.ok(m, "missing <footer id=\"request-spot\">");
  return m[0];
}

function formHtml(footer) {
  const m = footer.match(/<form id="request-spot-form"[^>]*>[\s\S]*?<\/form>/);
  assert.ok(m, "missing <form id=\"request-spot-form\">");
  return m[0];
}

function openTag(haystack, tag, attrNeedle) {
  const re = new RegExp(`<${tag}\\b[^>]*>`, "g");
  const matches = haystack.match(re) || [];
  const hit = matches.find((t) => t.includes(attrNeedle));
  assert.ok(hit, `no <${tag}> with ${attrNeedle}`);
  return hit;
}

test("every neighborhood board (including /baltimore) renders #request-spot after </main>", async () => {
  const views = await loadViews();
  const venues = await loadVenues();
  assert.ok(
    views.some((v) => v.slug === "baltimore"),
    "views.json has no baltimore board — test proves nothing",
  );

  for (const view of views) {
    const html = boardHtml(view, views, venues);
    const mainEnd = html.indexOf("</main>");
    const footerAt = html.indexOf('<footer id="request-spot">');
    assert.ok(mainEnd !== -1, `${view.slug} has no </main>`);
    assert.ok(footerAt !== -1, `${view.slug} is missing #request-spot`);
    assert.ok(
      footerAt > mainEnd,
      `${view.slug}: #request-spot must come after </main> (mainEnd=${mainEnd}, footerAt=${footerAt})`,
    );
    assert.equal(
      (html.match(/<footer id="request-spot">/g) || []).length,
      1,
      `${view.slug} must have exactly one #request-spot`,
    );
  }
});

test("request-spot markup: heading, meta, native POST form, labels, required name, optional note, submit", async () => {
  const views = await loadViews();
  const view = views.find((v) => v.slug === "baltimore") ?? views[0];
  const html = boardHtml(view, views, await loadVenues());
  const footer = footerHtml(html);
  const form = formHtml(footer);

  assert.match(footer, /<h2>Request a spot<\/h2>/);
  assert.ok(footer.includes(META), "missing exact meta line");

  const formOpen = openTag(form, "form", 'id="request-spot-form"');
  assert.match(formOpen, /method="POST"/);
  assert.ok(
    formOpen.includes(`action="${FORM_ACTION}"`),
    `form action must be the verified formResponse URL\n${formOpen}`,
  );
  assert.doesNotMatch(formOpen, /\btarget=/);

  // Exactly one form in the box.
  assert.equal((footer.match(/<form\b/g) || []).length, 1);

  const nameInput = openTag(form, "input", `name="${NAME_ENTRY}"`);
  assert.match(nameInput, /type="text"/);
  assert.match(nameInput, /\brequired\b/);
  assert.doesNotMatch(nameInput, /type="hidden"/);

  const noteOpen = openTag(form, "textarea", `name="${NOTE_ENTRY}"`);
  assert.doesNotMatch(noteOpen, /\brequired\b/);
  assert.doesNotMatch(noteOpen, /type="hidden"/);

  // Labels sit on the controls (for= matches id, or the control is wrapped).
  const nameId = nameInput.match(/\bid="([^"]+)"/);
  const noteId = noteOpen.match(/\bid="([^"]+)"/);
  assert.ok(nameId, "spot-name input needs an id so the label can point at it");
  assert.ok(noteId, "note textarea needs an id so the label can point at it");
  assert.match(
    form,
    new RegExp(`<label[^>]*for="${nameId[1]}"[^>]*>\\s*Spot name\\s*</label>`),
  );
  assert.match(
    form,
    new RegExp(
      `<label[^>]*for="${noteId[1]}"[^>]*>\\s*Note \\(optional\\)\\s*</label>`,
    ),
  );

  const submit = (form.match(/<(?:button|input)\b[^>]*>/g) || []).find((t) =>
    /\btype="submit"/.test(t),
  );
  assert.ok(submit, "missing type=\"submit\" control");
  assert.doesNotMatch(submit, /\bhidden\b/);
  assert.doesNotMatch(submit, /hidden=""/);
  assert.doesNotMatch(submit, /type="hidden"/);

  // Native form — JS-off still submits. No JS file, no iframe, no fetch wrapper.
  assert.doesNotMatch(form, /\bonsubmit=/);
  assert.doesNotMatch(footer, /<iframe\b/i);
  assert.doesNotMatch(footer, /<script\b/i);

  // No email, captcha, or extra hidden Google fields.
  assert.doesNotMatch(form, /type="email"/);
  assert.doesNotMatch(form, /captcha/i);
  assert.doesNotMatch(form, /type="hidden"/);
  const entryNames = [...form.matchAll(/\bname="(entry\.[^"]+)"/g)].map(
    (m) => m[1],
  );
  assert.deepEqual(
    entryNames.sort(),
    [NAME_ENTRY, NOTE_ENTRY].sort(),
    "only the two verified Google entry IDs",
  );
});

test("style.css styles the box with existing tokens; does not undo color-scheme: light", async () => {
  const css = await readFile(new URL("../public/style.css", import.meta.url), "utf8");
  assert.match(css, /#request-spot\b/);
  assert.match(css, /color-scheme:\s*light\s*;/);
  assert.doesNotMatch(css, /color-scheme:\s*light\s+dark/);
  assert.doesNotMatch(css, /prefers-color-scheme:\s*dark/);
});
