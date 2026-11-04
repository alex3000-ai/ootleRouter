// Voucher keys and signatures, made on your own machine (Node or a browser).
// Ristretto Schnorr as the engine verifies a template signature (Ootle ≥ 0.49, tari_ootle_common_types
// engine_signature.rs): s = r + e·k, with e = H("challenge"; R, P, H("message"; network, scope, component, domain,
// message)) mod l. H is Blake2b-512 under the tag "com.tari.ootle.template_signature.v1.<label>", every input preceded
// by its length (u64, little-endian), as tari_crypto's DomainSeparatedHasher does. The scope is the lanes component.

import { ristretto255 } from "@noble/curves/ed25519.js";
import { blake2b } from "@noble/hashes/blake2.js";

export const VOUCHER_DOMAIN = "ootlerouter-voucher-v1";
/** Network bytes (ootle_network). */
export const NETWORKS = { mainnet: 0x00, stagenet: 0x01, nextnet: 0x02, localnet: 0x10, igor: 0x24, esmeralda: 0x26 };
const TAG = "com.tari.ootle.template_signature.v1";
const SCOPE_COMPONENT = 2;

const Point = ristretto255.Point;
const ORDER = Point.Fn.ORDER;
const enc = new TextEncoder();
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (h) => {
  const clean = String(h).trim().replace(/^0x/i, "");
  if (!/^([0-9a-fA-F]{2})*$/.test(clean)) throw new Error("invalid hex");
  return Uint8Array.from(clean.match(/../g) ?? [], (b) => parseInt(b, 16));
};
const randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));
const leToBigInt = (b) => b.reduceRight((n, byte) => (n << 8n) | BigInt(byte), 0n);
const le32 = (n) => {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++, n >>= 8n) out[i] = Number(n & 0xffn);
  return out;
};
const randomScalar = () => {
  for (;;) {
    const k = leToBigInt(randomBytes(64)) % ORDER;
    if (k !== 0n) return k;
  }
};
function parseSecret(secretHex) {
  const bytes = fromHex(secretHex);
  const k = leToBigInt(bytes);
  if (bytes.length !== 32 || k === 0n || k >= ORDER) throw new Error("a secret key is a canonical non-zero 32-byte scalar");
  return k;
}

const u64le = (n) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return b; };
function hasher(label) {
  const h = blake2b.create({ dkLen: 64 }), tag = enc.encode(`${TAG}.${label}`);
  h.update(u64le(tag.length)).update(tag);
  const self = { chain: (x) => (h.update(u64le(x.length)).update(x), self), digest: () => h.digest() };
  return self;
}

function challenge(nonce, publicKey, { hub, lane, spent_cum, network }) {
  if (!(network in NETWORKS)) throw new Error(`unknown network ${network}`);
  const bound = hasher("message").chain(Uint8Array.of(NETWORKS[network])).chain(Uint8Array.of(SCOPE_COMPONENT))
    .chain(fromHex(hub.replace(/^component_/, ""))).chain(enc.encode(VOUCHER_DOMAIN)).chain(enc.encode(voucherMessage(hub, lane, spent_cum))).digest();
  return leToBigInt(hasher("challenge").chain(nonce).chain(publicKey).chain(bound).digest()) % ORDER;
}

export function keygen() {
  const k = randomScalar();
  return { secretKey: hex(le32(k)), publicKey: hex(Point.BASE.multiply(k).toBytes()) };
}

export const publicKeyOf = (secretHex) => hex(Point.BASE.multiply(parseSecret(secretHex)).toBytes());

/** Whether 32 bytes of hex are a valid public key (a voucher key that isn't can never sign a voucher). */
export function isPublicKey(h) {
  try { Point.fromBytes(fromHex(h)); return /^[0-9a-f]{64}$/i.test(h); } catch { return false; }
}

/** What a voucher signs (template/src/lib.rs, voucher_message): `spentCum` µT in all may have been claimed. */
export function voucherMessage(hub, lane, spentCum) {
  if (!/^component_[0-9a-f]{64}$/.test(hub ?? "")) throw new Error("expected a component_<64 hex> address");
  return `${hub}|${BigInt(lane)}|${BigInt(spentCum)}`;
}

/** A voucher for lane `lane` of the lanes component `hub` on `network`: the provider may claim up to `spentCum` µT. */
export function signVoucher(secretHex, hub, lane, spentCum, network) {
  const k = parseSecret(secretHex);
  const r = randomScalar();
  const P = Point.BASE.multiply(k).toBytes(), R = Point.BASE.multiply(r).toBytes();
  const v = { network, hub, lane: Number(lane), spent_cum: String(BigInt(spentCum)) };
  const s = (r + challenge(R, P, v) * k) % ORDER;
  return { ...v, public_key: hex(P), public_nonce: hex(R), signature: hex(le32(s)) };
}

/** Checks a voucher's signature the way the template does. Garbage is false, never an exception. */
export function verifyVoucher({ network, hub, lane, spent_cum, public_key, public_nonce, signature }) {
  try {
    const P = Point.fromBytes(fromHex(public_key)), R = Point.fromBytes(fromHex(public_nonce));
    const s = leToBigInt(fromHex(signature));
    if (s >= ORDER) return false;
    const e = challenge(fromHex(public_nonce), fromHex(public_key), { hub, lane, spent_cum, network });
    const lhs = s === 0n ? Point.ZERO : Point.BASE.multiply(s);
    return lhs.equals(e === 0n ? R : R.add(P.multiply(e)));
  } catch {
    return false;
  }
}
