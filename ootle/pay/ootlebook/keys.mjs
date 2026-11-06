// Keys and signatures for Ootlebook, made on your own machine: owner statements (cards) and lane vouchers.
// Ristretto Schnorr as the engine verifies a template signature (Ootle ≥ 0.49, tari_ootle_common_types
// engine_signature.rs): s = r + e·k, with e = H("challenge"; R, P, H("message"; network, scope, component, domain,
// message)) mod l. H is Blake2b-512 under the tag "com.tari.ootle.template_signature.v1.<label>", every input preceded
// by its length (u64, little-endian). The scope is the Ootlebook component, so a signature is good for it alone.

import { ristretto255 } from "@noble/curves/ed25519.js";
import { blake2b } from "@noble/hashes/blake2.js";

export const OWNER_DOMAIN = "ootlebook-owner-v1";
export const VOUCHER_DOMAIN = "ootlebook-voucher-v1";
/** Network bytes (ootle_network). */
export const NETWORKS = { mainnet: 0x00, stagenet: 0x01, nextnet: 0x02, localnet: 0x10, igor: 0x24, esmeralda: 0x26 };
const TAG = "com.tari.ootle.template_signature.v1";

const Point = ristretto255.Point;
const ORDER = Point.Fn.ORDER;
const enc = new TextEncoder();
// Plain bytes and the Web Crypto random source, so the same file runs in Node and in a browser (ootlebook.com/router).
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (h) => {
  const clean = String(h).trim().replace(/^0x/i, "");
  if (!/^([0-9a-fA-F]{2})*$/.test(clean)) throw new Error("invalid hex");
  return Uint8Array.from(clean.match(/../g) ?? [], (x) => parseInt(x, 16));
};
const leToBigInt = (b) => b.reduceRight((n, byte) => (n << 8n) | BigInt(byte), 0n);
const le32 = (n) => {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++, n >>= 8n) out[i] = Number(n & 0xffn);
  return out;
};
const randomScalar = () => {
  for (;;) {
    const k = leToBigInt(globalThis.crypto.getRandomValues(new Uint8Array(64))) % ORDER;
    if (k !== 0n) return k;
  }
};
function parseSecret(secretHex) {
  const bytes = fromHex(secretHex);
  const k = leToBigInt(bytes);
  if (bytes.length !== 32 || k === 0n || k >= ORDER) throw new Error("a secret key is a canonical non-zero 32-byte scalar");
  return k;
}
const bytesOf = (message) => (typeof message === "string" ? enc.encode(message) : message);

const u64le = (n) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return b; };
function hasher(label) {
  const h = blake2b.create({ dkLen: 64 }), tag = enc.encode(`${TAG}.${label}`);
  h.update(u64le(tag.length)).update(tag);
  const self = { chain: (x) => (h.update(u64le(x.length)).update(x), self), digest: () => h.digest() };
  return self;
}

/** `binding` is {network, hub}: the network's name and the component that verifies. */
function challenge(domain, nonce, publicKey, message, { network, hub }) {
  if (!(network in NETWORKS)) throw new Error(`unknown network ${network}`);
  const bound = hasher("message").chain(Uint8Array.of(NETWORKS[network])).chain(Uint8Array.of(2))
    .chain(fromHex(component(hub).replace(/^component_/, ""))).chain(enc.encode(domain)).chain(bytesOf(message)).digest();
  return leToBigInt(hasher("challenge").chain(nonce).chain(publicKey).chain(bound).digest()) % ORDER;
}

export function keygen() {
  const k = randomScalar();
  return { secretKey: hex(le32(k)), publicKey: hex(Point.BASE.multiply(k).toBytes()) };
}

export const publicKeyOf = (secretHex) => hex(Point.BASE.multiply(parseSecret(secretHex)).toBytes());

/** Signs `message` (text or bytes) under `domain` for component `binding.hub` on `binding.network`. Returns hex
 *  {public_key, public_nonce, signature}. */
export function sign(domain, secretHex, message, binding) {
  const k = parseSecret(secretHex);
  const r = randomScalar();
  const P = Point.BASE.multiply(k).toBytes(), R = Point.BASE.multiply(r).toBytes();
  return { public_key: hex(P), public_nonce: hex(R), signature: hex(le32((r + challenge(domain, R, P, message, binding) * k) % ORDER)) };
}

/** Checks a signature the way the template does. Garbage is false, never an exception. */
export function verify(domain, { public_key, public_nonce, signature }, message, binding) {
  try {
    const P = Point.fromBytes(fromHex(public_key)), R = Point.fromBytes(fromHex(public_nonce));
    const s = leToBigInt(fromHex(signature));
    if (s >= ORDER) return false;
    const e = challenge(domain, fromHex(public_nonce), fromHex(public_key), message, binding);
    const lhs = s === 0n ? Point.ZERO : Point.BASE.multiply(s);
    return lhs.equals(e === 0n ? R : R.add(P.multiply(e)));
  } catch {
    return false;
  }
}

/** Whether 32 bytes of hex are a valid public key (a voucher key that isn't can never sign a voucher). */
export function isPublicKey(h) {
  try { Point.fromBytes(fromHex(h)); return /^[0-9a-f]{64}$/i.test(h); } catch { return false; }
}

// The exact messages the template rebuilds (template/src/lib.rs, *_message).
const component = (c) => {
  if (!/^component_[0-9a-f]{64}$/.test(c ?? "")) throw new Error("expected a component_<64 hex> address");
  return c;
};
const key = (k, what) => {
  if (!/^[0-9a-f]{64}$/.test(k ?? "")) throw new Error(`${what} must be 32 bytes of lowercase hex`);
  return k;
};
export const statements = {
  register: (hub, name, agentKey, messaging = "") => `register|${component(hub)}|${name}|${key(agentKey, "agent key")}|${messaging}`,
  rotate: (hub, name, nonce, newAgentKey) => `rotate|${component(hub)}|${name}|${BigInt(nonce)}|${key(newAgentKey, "new agent key")}`,
  retire: (hub, name, nonce) => `retire|${component(hub)}|${name}|${BigInt(nonce)}`,
  transfer: (hub, name, nonce, newOwner) => `transfer|${component(hub)}|${name}|${BigInt(nonce)}|${key(newOwner, "new owner key")}`,
};

/** A voucher: the lane's voucher key authorises the provider to have claimed `spentCum` µT in all. */
export const voucherMessage = (hub, lane, spentCum) => `${component(hub)}|${lane}|${BigInt(spentCum)}`;

export function signVoucher(secretHex, hub, lane, spentCum, network) {
  return { network, hub, lane, spent_cum: String(BigInt(spentCum)), ...sign(VOUCHER_DOMAIN, secretHex, voucherMessage(hub, lane, spentCum), { network, hub }) };
}

export const verifyVoucher = (v) => {
  try { return verify(VOUCHER_DOMAIN, v, voucherMessage(v.hub, v.lane, v.spent_cum), { network: v.network, hub: v.hub }); } catch { return false; }
};
