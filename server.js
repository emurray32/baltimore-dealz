import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { renderBoard } from "./src/page.js";
import { loadVenues } from "./src/venues.js";

const STYLE_FILE = fileURLToPath(new URL("./public/style.css", import.meta.url));

const server = createServer(async (req, res) => {
  try {
    if (req.url === "/style.css") {
      res.writeHead(200, { "content-type": "text/css; charset=utf-8" });
      res.end(await readFile(STYLE_FILE, "utf8"));
      return;
    }
    if (req.url === "/" || req.url === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(renderBoard(await loadVenues()));
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
