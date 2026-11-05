// The public onion's only door into the router: the API (/api/harness/v1/…) and nothing else, so the console, its
// login and the files it serves can't be reached from the public address. Headers that would say what runs behind
// it, and cookies either way, are dropped.   node gate.mjs <listen ip>:<port> <router ip>:<port>
import { createServer, request } from "node:http";

const [listen, target] = process.argv.slice(2).map((a) => a.split(":"));
const PREFIX = "/api/harness/v1/";
const DROP_UP = ["cookie", "forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip"];
const DROP_DOWN = ["set-cookie", "server", "x-powered-by", "x-nextjs-cache", "x-nextjs-prerender", "x-nextjs-stale-time", "x-middleware-rewrite"];

createServer((req, res) => {
  // Dot segments and their encodings are resolved first, so /api/harness/v1/../../login is /login, which is refused;
  // an encoded slash, backslash or dot left after that is refused too, whatever the router would make of it.
  let url;
  try { url = new URL(req.url, "http://router"); } catch { url = null; }
  if (!url || !url.pathname.startsWith(PREFIX) || /%(2f|5c|2e)/i.test(url.pathname)) return res.writeHead(404, { "content-type": "application/json" }).end('{"code":"not_found"}');
  const headers = { ...req.headers, host: "router" };
  for (const h of DROP_UP) delete headers[h];
  const up = request({ host: target[0], port: Number(target[1]), method: req.method, path: url.pathname + url.search, headers }, (r) => {
    for (const h of DROP_DOWN) delete r.headers[h];
    res.writeHead(r.statusCode, r.headers);
    r.pipe(res);
  });
  up.on("error", () => (res.headersSent ? res.destroy() : res.writeHead(502).end()));
  res.on("close", () => up.destroy());
  req.pipe(up);
}).listen(Number(listen[1]), listen[0], () => console.log(`gate ${listen.join(":")} -> ${target.join(":")}${PREFIX}`));
