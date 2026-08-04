import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const VIEWS_FILE = fileURLToPath(new URL("../data/views.json", import.meta.url));

export async function loadViews() {
  return JSON.parse(await readFile(VIEWS_FILE, "utf8")).views;
}

// The board someone lands on when they don't name one.
export function defaultView(views) {
  return views[0];
}

export function findView(views, slug) {
  return views.find((view) => view.slug === slug);
}
