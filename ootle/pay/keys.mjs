// Voucher keys and signatures, made on your own machine (Node or a browser).
// Ristretto Schnorr as the template verifies it: e = Blake2b-512(domain || R || P || message) mod l, s = r + e·k.

import { ristretto255 } from "@noble/curves/ed25519.js";
import { blake2b } from "@noble/hashes/blake2.js";

export const VOUCHER_DOMAIN = "ootlerouter-voucher-v1";

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

function challenge(nonce, publicKey, message) {
  const h = blake2b.create({ dkLen: 64 });
  h.update(enc.encode(VOUCHER_DOMAIN)).update(nonce).update(publicKey).update(enc.encode(message));
  return leToBigInt(h.digest()) % ORDER;
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

export function signVoucher(secretHex, hub, lane, spentCum) {
  const k = parseSecret(secretHex);
  const r = randomScalar();
  const P = Point.BASE.multiply(k).toBytes(), R = Point.BASE.multiply(r).toBytes();
  const s = (r + challenge(R, P, voucherMessage(hub, lane, spentCum)) * k) % ORDER;
  return { hub, lane: Number(lane), spent_cum: String(BigInt(spentCum)), public_key: hex(P), public_nonce: hex(R), signature: hex(le32(s)) };
}

/** Checks a voucher's signature the way the template does. Garbage is false, never an exception. */
export function verifyVoucher({ hub, lane, spent_cum, public_key, public_nonce, signature }) {
  try {
    const P = Point.fromBytes(fromHex(public_key)), R = Point.fromBytes(fromHex(public_nonce));
    const s = leToBigInt(fromHex(signature));
    if (s >= ORDER) return false;
    const e = challenge(fromHex(public_nonce), fromHex(public_key), voucherMessage(hub, lane, spent_cum));
    const lhs = s === 0n ? Point.ZERO : Point.BASE.multiply(s);
    return lhs.equals(e === 0n ? R : R.add(P.multiply(e)));
  } catch {
    return false;
  }
}
