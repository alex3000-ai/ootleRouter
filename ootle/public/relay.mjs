// Relays a fixed list of TCP ports to fixed destinations, and nothing else. The router's container sits on a
// network with no way out; this relay is its only door.   node relay.mjs 8899=host:8899 443=example.com:443 …
import { createConnection, createServer } from "node:net";

for (const spec of process.argv.slice(2)) {
  const m = /^(\d+)=([^:]+):(\d+)$/.exec(spec);
  if (!m) throw new Error(`expected <listen port>=<host>:<port>, got ${spec}`);
  const [, listen, host, port] = m;
  createServer((inbound) => {
    const out = createConnection({ host, port: Number(port) });
    inbound.pipe(out).pipe(inbound);
    const close = () => { inbound.destroy(); out.destroy(); };
    inbound.on("error", close);
    out.on("error", close);
  }).listen(Number(listen), "0.0.0.0", () => console.log(`relay :${listen} -> ${host}:${port}`));
}
