// Relays a fixed list of TCP ports to fixed destinations, and nothing else. Each port listens on one address, so only
// the network that address belongs to can use it; `/tor` sends that destination through Tor's SOCKS port (--socks).
//   node relay.mjs --socks 172.31.252.2:9050 172.31.252.3:443=example.com:443/tor 172.31.251.2:8080=172.17.0.1:8080
import { createConnection, createServer } from "node:net";

const args = process.argv.slice(2);
const socks = args[0] === "--socks" ? args.splice(0, 2)[1].split(":") : null;

/** Opens host:port through Tor: SOCKS5, no auth, the name resolved by Tor (no DNS here). */
function viaTor(host, port, onReady, onFail) {
  const s = createConnection({ host: socks[0], port: Number(socks[1]) });
  let buf = Buffer.alloc(0), step = 0;
  s.on("data", function read(d) {
    buf = Buffer.concat([buf, d]);
    if (step === 0 && buf.length >= 2) {
      if (buf[0] !== 5 || buf[1] !== 0) return onFail(s);
      buf = buf.subarray(2); step = 1;
      const name = Buffer.from(host);
      s.write(Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, Buffer.from([port >> 8, port & 0xff])]));
    }
    if (step === 1 && buf.length >= 5) {
      const need = { 1: 10, 3: 7 + buf[4], 4: 22 }[buf[3]];
      if (buf[1] !== 0 || !need) return onFail(s);
      if (buf.length < need) return;
      s.off("data", read);
      onReady(s, buf.subarray(need));
    }
  });
  s.write(Buffer.from([5, 1, 0]));
  return s;
}

for (const spec of args) {
  const m = /^([\d.]+):(\d+)=([^:/]+):(\d+)(\/tor)?$/.exec(spec);
  if (!m) throw new Error(`expected <listen ip>:<port>=<host>:<port>[/tor], got ${spec}`);
  const [, ip, listen, host, port, tor] = m;
  if (tor && !socks) throw new Error(`${spec} needs --socks`);
  createServer({ pauseOnConnect: true }, (inbound) => {
    const close = () => { inbound.destroy(); out.destroy(); };
    const join = (s, early) => { if (early.length) inbound.write(early); inbound.pipe(s).pipe(inbound); inbound.resume(); };
    const out = tor ? viaTor(host, Number(port), join, close) : createConnection({ host, port: Number(port) }, () => join(out, Buffer.alloc(0)));
    inbound.on("error", close);
    out.on("error", close);
    out.on("close", close);
  }).listen(Number(listen), ip, () => console.log(`relay ${ip}:${listen} -> ${host}:${port}${tor ? " via Tor" : ""}`));
}
