"""Pay-per-use through OotleRouterLanes: who pays, what is refused, and what a finished turn is charged."""
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
        return {"hold": "h-1", "lane": 0, "balance": 5_000}

    async def charge(_client, hold, amount):
        asked.append(("charge", hold, amount))

    monkeypatch.setattr(ootle_pay, "admit", admit)
    monkeypatch.setattr(ootle_pay, "charge", charge)
    return asked


def _turn(monkeypatch, via, headers=None):
    """A turn request from a caller of kind `via`, stopped with a 418 where the session would be resolved,
    the first step after payment."""
    async def principal(_request):
        return {"org": "org-1", "member": "m", "via": via}

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
    r = _turn(monkeypatch, "api_key", {"X-Ootle-Voucher": '{"lane": 0}'})
    assert r.status_code == 418, r.text
    assert paid == [("admit", '{"lane": 0}')]


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
