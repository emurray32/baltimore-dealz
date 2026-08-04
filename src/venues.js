import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const DATA_FILE = fileURLToPath(new URL("../data/venues.json", import.meta.url));

// Read on every call: a future crawler can rewrite venues.json and the board
// picks it up without a restart.
export async function loadVenues() {
  return JSON.parse(await readFile(DATA_FILE, "utf8")).venues;
}
