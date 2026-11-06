"""Pay-per-use through Ootlebook lanes: who pays, what is refused, what a finished turn is charged, and a lane's own key."""
import json
import pathlib
import sys

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import app as A  # noqa: E402
import ootle_pay  # noqa: E402

PRICES = {"harness.session_minute": 600, "llm.*.input_1k": 10, "llm.*.output_1k": 40, "llm.gpt-x.input_1k": 2}


@pytest.fixture
def paid(monkeypatch, tmp_path):
    """Payments on, a price file, and a payment service that records what it is asked."""
    prices = tmp_path / "prices.json"
    prices.write_text(json.dumps(PRICES))
    monkeypatch.setattr(ootle_pay, "URL", "http://pay.test")
    monkeypatch.setattr(ootle_pay, "PRICES", str(prices))
    monkeypatch.setattr(A, "_pricing_table", {})
    monkeypatch.setattr(A, "_pricing_fetched_at", 0.0)
    asked = []

    async def admit(_client, header):
        asked.append(("admit", header))
        if not header:
            raise ootle_pay.Refused({"code": "voucher_required", "message": "Send a voucher."})
        return {"hold": "h-1", "lane": "router.0", "balance": 5_000}

    async def charge(_client, hold, amount):
        asked.append(("charge", hold, amount))

    monkeypatch.setattr(ootle_pay, "admit", admit)
    monkeypatch.setattr(ootle_pay, "charge", charge)
    return asked


def _turn(monkeypatch, via, headers=None, workspace=""):
    """A turn request from a caller of kind `via`, stopped with a 418 where the session would be resolved,
    the first step after payment."""
    async def principal(_request):
        return {"org": "org-1", "member": "m", "via": via, "workspace": workspace}

    async def chain(*_a, **_k):
        return ["openai"]

    async def resolve(*_a, **_k):
        raise A.HTTPException(418, "past the payment gate")
    monkeypatch.setattr(A, "_principal", principal)
    monkeypatch.setattr(A, "_resolve_chain", chain)
    monkeypatch.setattr(A, "_resp_resolve_session", resolve)
    body = {"input": "hi", "model": "gpt-x", "metadata": {"harness_id": "codex"}}
    return TestClient(A.app).post("/v1/responses", json=body, headers=headers or {})


def test_an_api_caller_without_a_voucher_is_refused_with_402(paid, monkeypatch):
    r = _turn(monkeypatch, "api_key")
    assert r.status_code == 402, r.text
    err = r.json()["error"]
    assert (err["code"], err["param"]) == ("voucher_required", "X-Ootle-Voucher")
    assert paid == [("admit", None)]


def test_an_api_caller_with_an_admitted_voucher_goes_on(paid, monkeypatch):
    r = _turn(monkeypatch, "api_key", {"X-Ootle-Voucher": '{"lane": "router.0"}'})
    assert r.status_code == 418, r.text
    assert paid == [("admit", '{"lane": "router.0"}')]


def test_the_consoles_own_turns_are_not_asked_to_pay(paid, monkeypatch):
    assert _turn(monkeypatch, "internal").status_code == 418
    assert paid == []


async def test_prices_come_from_the_operators_file_with_a_price_for_every_model(paid):
    await A._refresh_pricing_table()
    usage = {"input_tokens": 2_000, "output_tokens": 500}
    # one minute + 2k input at the model's own row + 0.5k output at the every-model row
    assert A._run_credits("gpt-x", usage, 60) == 600 + 4 + 20
    assert A._run_credits("other-model", usage, 0) == 20 + 20


async def test_a_finished_turn_charges_its_hold_once(paid, monkeypatch):
    sid = "sess-ootle-1"
    A._session_trace[sid] = {"prefix": f"traces/org-1/{sid}", "org": "org-1", "ootle_hold": "h-1"}
    rec = {"model": "gpt-x", "usage": {"input_tokens": 1_000}, "elapsed": 30, "status": "completed"}
    await A._trace_finalize(sid, rec)
    await A._trace_finalize(sid, rec)
    assert paid == [("charge", "h-1", 300 + 2)]


def test_a_lanes_key_pays_only_with_its_own_lanes_vouchers(paid, monkeypatch):
    other = _turn(monkeypatch, "api_key", {"X-Ootle-Voucher": '{"lane": "router.4"}'}, workspace="ootle-lane-3")
    assert other.status_code == 403, other.text
    assert paid == [], "refused before the payment service is asked"
    own = _turn(monkeypatch, "api_key", {"X-Ootle-Voucher": '{"lane": "router.3"}'}, workspace="ootle-lane-3")
    assert own.status_code == 418, own.text


@pytest.fixture
def keys(paid, monkeypatch):
    """The payment service's verdict on an offered voucher, and the key store, recorded."""
    store = {"rows": [], "made": [], "revoked": []}

    async def offer(_client, header):
        if '"good"' not in (header or ""):
            raise ootle_pay.Refused({"code": "voucher_invalid", "message": "no"})
        return {"lane": "router.3", "charged": 0}

    async def made(org, member, name, workspace, ws_default):
        store["made"].append((org, member, workspace, ws_default))
        return f"sk-hr-{len(store['made'])}", f"id-{len(store['made'])}"

    async def revoked(kid):
        store["revoked"].append(kid)

    async def find(kind, where):
        return [r for r in store["rows"] if r["org"] == where["org"]]
    monkeypatch.setattr(ootle_pay, "offer", offer)
    monkeypatch.setattr(A, "_store_api_key", made)
    monkeypatch.setattr(A, "_revoke_api_key", revoked)
    monkeypatch.setattr(A.BACKING.graph, "find", find)
    return store


def test_a_voucher_gets_a_key_held_to_its_lanes_workspace_and_replaces_the_last(keys):
    c = TestClient(A.app)
    bad = c.post("/v1/ootle/keys", headers={"X-Ootle-Voucher": '{"sig": "bad"}'})
    assert bad.status_code == 402 and keys["made"] == []
    keys["rows"] = [{"id": "old", "org": "local", "workspace": "ootle-lane-3"}, {"id": "other", "org": "local", "workspace": "ootle-lane-4"}]
    r = c.post("/v1/ootle/keys", headers={"X-Ootle-Voucher": '{"sig": "good"}'})
    assert r.status_code == 200, r.text
    assert (r.json()["key"], r.json()["workspace"]) == ("sk-hr-1", "ootle-lane-3")
    assert keys["made"] == [("local", "lane:router.3", "ootle-lane-3", False)], "held to the lane's workspace, not the org"
    assert keys["revoked"] == ["old"], "only this lane's earlier key is replaced"


def test_how_to_pay_is_readable_without_a_key(paid, monkeypatch):
    async def get(_client, path):
        return {"agent": "router", "reserve_microtari": 10_000} if path == "/info" else {}
    monkeypatch.setattr(ootle_pay, "get", get)
    r = TestClient(A.app).get("/v1/ootle")
    assert r.status_code == 200, r.text
    assert r.json()["agent"] == "router" and r.json()["prices"]["harness.session_minute"] == 600
