// Indexers from Tari Ootle v0.48 send substate values, events and UTXOs as base64 CBOR; older ones send JSON. Tari's own
// decoder turns the CBOR back into exactly that JSON, so every reader accepts both.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as bg from "@tari-project/ootle-wasm-bor/ootle_wasm_bor_bg.js";

const wasm = createRequire(import.meta.url).resolve("@tari-project/ootle-wasm-bor/ootle_wasm_bor_bg.wasm");
const { instance } = await WebAssembly.instantiate(readFileSync(wasm), { "./ootle_wasm_bor_bg.js": bg });
bg.__wbg_set_wasm(instance.exports);
instance.exports.__wbindgen_start();

const plain = (v, decode) => (typeof v === "string" ? JSON.parse(decode(v)) : v);

/** An indexer response body with its substate value and events as JSON. */
export function plainBody(body) {
  const up = body?.state?.up;
  if (up) up.substate = plain(up.substate, bg.decodeSubstateValue);
  if (Array.isArray(body?.events)) body.events = body.events.map(([id, e]) => [id, plain(e, bg.decodeEvent)]);
  return body;
}

export const plainUtxo = (v) => plain(v, bg.decodeUtxo);
