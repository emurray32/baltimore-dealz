import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { venuesForView } from "./src/deals.js";
import { renderBoard } from "./src/page.js";
import { loadVenues } from "./src/venues.js";
import { defaultView, findView, loadViews } from "./src/views.js";

const STYLE_FILE = fileURLToPath(new URL("./public/style.css", import.meta.url));

const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, "http://localhost").pathname;

    if (path === "/style.css") {
      res.writeHead(200, { "content-type": "text/css; charset=utf-8" });
      res.end(await readFile(STYLE_FILE, "utf8"));
      return;
    }

    const views = await loadViews();

    // No view named? Send them to the default one rather than inventing a
    // homepage that would have to hard-code a neighborhood.
    if (path === "/" || path === "/index.html") {
      res.writeHead(302, { location: `/${defaultView(views).slug}` });
      res.end();
      return;
    }

    const view = findView(views, path.slice(1));
    if (view) {
      const venues = venuesForView(await loadVenues(), view);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(renderBoard(venues, view, views));
      return;
    }

    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  } catch (error) {
    console.error(error);
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end("Something broke loading the deals.");
  }
});

const port = Number(process.env.PORT) || 3000;
server.listen(port, "0.0.0.0", () => {
  console.log(`Baltimore Dealz on http://localhost:${port}`);
});
