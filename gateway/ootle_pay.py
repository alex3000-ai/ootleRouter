"""Pay-per-use in tTARI through Ootlebook's payment lanes (ootle/): the gateway's side.

On when OOTLE_PAY_URL names the payment service (ootle/pay/server.mjs). Then an API-key caller pays for each turn
with a voucher on an Ootlebook lane to this router's card, sent as the X-Ootle-Voucher header (the voucher's JSON).
The service admits the turn and holds a reserve; when the turn finishes, its cost, priced from OOTLE_PRICES like the
hosted service's credits (µT per unit), is charged and the hold let go. The Console's own turns are free: the
operator runs them. A voucher alone also gets a hiring agent a key of its lane's own (offer, then app.py's
/v1/ootle/keys), so no person has to hand one out.
"""
import json
import os

import httpx

URL = os.environ.get("OOTLE_PAY_URL", "").rstrip("/")
TOKEN = os.environ.get("OOTLE_PAY_TOKEN", "")
PRICES = os.environ.get("OOTLE_PRICES", "")
HEADER = "x-ootle-voucher"


def enabled() -> bool:
    return bool(URL)


def price_table() -> dict:
    """The operator's prices as the gateway's pricing table: {"system": {metric: µT per unit}}. Metrics are
    harness.session_minute and llm.<model>.<input|output|cache_read|cache_write>_1k; llm.*.<kind> prices every
    model without its own row."""
    with open(PRICES, encoding="utf-8") as f:
        table = json.load(f)
    if not isinstance(table, dict) or not all(isinstance(v, (int, float)) and v >= 0 for v in table.values()):
        raise ValueError(f"{PRICES} must map metric names to non-negative numbers")
    return {"system": table}


class Refused(Exception):
    """The service would not start a turn: `detail` says why and what the lane holds."""

    def __init__(self, detail: dict):
        super().__init__(detail.get("message") or "payment required")
        self.detail = detail


async def _post(client: httpx.AsyncClient, path: str, body: dict) -> httpx.Response:
    return await client.post(f"{URL}{path}", json=body, headers={"x-ootle-pay-token": TOKEN}, timeout=20)


def voucher_of(header: str | None) -> dict | None:
    """The X-Ootle-Voucher header's voucher, None when there is none; raises Refused when it isn't one."""
    try:
        voucher = json.loads(header) if header else None
    except ValueError:
        voucher = None
    if header and not isinstance(voucher, dict):
        raise Refused({"code": "voucher_invalid", "message": "X-Ootle-Voucher must be the voucher's JSON."})
    return voucher


async def _decided(r: httpx.Response) -> dict:
    if r.status_code == 402:
        raise Refused(r.json())
    r.raise_for_status()
    return r.json()


async def admit(client: httpx.AsyncClient, header: str | None) -> dict:
    """Admits a turn on the caller's voucher. Returns {hold, lane, balance, ...}; raises Refused. Unlike the
    hosted credit gate this fails CLOSED: an unreachable service means nobody is paying."""
    return await _decided(await _post(client, "/admit", {"voucher": voucher_of(header)}))


async def offer(client: httpx.AsyncClient, header: str | None) -> dict:
    """Checks and keeps the caller's voucher without starting a turn. Returns the lane's status; raises Refused."""
    return await _decided(await _post(client, "/offer", {"voucher": voucher_of(header)}))


async def start(client: httpx.AsyncClient, hold: str) -> None:
    """The admitted turn is running: keep its hold until it is charged."""
    (await _post(client, "/start", {"hold": hold})).raise_for_status()


async def charge(client: httpx.AsyncClient, hold: str, microtari: float) -> None:
    r = await _post(client, "/charge", {"hold": hold, "amount": microtari})
    if r.status_code != 404:       # 404: already charged, or lapsed
        r.raise_for_status()


async def get(client: httpx.AsyncClient, path: str) -> dict:
    r = await client.get(f"{URL}{path}", headers={"x-ootle-pay-token": TOKEN}, timeout=20)
    r.raise_for_status()
    return r.json()
