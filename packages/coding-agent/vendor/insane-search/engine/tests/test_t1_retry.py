#!/usr/bin/env python3
"""Regression tests — transient-status retry with exponential backoff.

Deterministic, network-free. Locks in:
  * 429 → 429 → 200 sequence recovers (3 calls, final 200)
  * 503 → 503 → 200 recovers similarly
  * 404 is NOT retried (terminal status, no backoff wasted)
  * 200 is returned immediately (no retry attempt)
  * a numeric Retry-After header overrides the exponential backoff delay
  * total retry sleep is capped — a huge Retry-After cannot stall the caller
  * POOL.request defaults to max_retries=0 (grid attempts must not retry)

Run:  python3 engine/tests/test_t1_retry.py
"""
from __future__ import annotations

import inspect
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, ROOT)

import engine.transport as t  # noqa: E402
from engine.transport import _retry_after_seconds, _retry_transient  # noqa: E402

# Record sleeps instead of really sleeping so the test is fast + assertable.
SLEEPS: list[float] = []
t.time.sleep = lambda s: SLEEPS.append(s)


class _FakeResp:
    def __init__(self, content=b"", status=200, headers=None):
        self.content = content
        self.text = content.decode("utf-8", "replace") if isinstance(content, (bytes, bytearray)) else content
        self.status_code = status
        self.headers = headers or {}


def t_429_then_200_recovers() -> None:
    seq = iter([429, 429, 200])
    calls = {"n": 0}

    def fake_get(url):
        calls["n"] += 1
        return _FakeResp(b"ok", status=next(seq))

    SLEEPS.clear()
    r = _retry_transient(fake_get, "https://x.test/", max_attempts=2)
    assert calls["n"] == 3, f"expected 3 calls, got {calls['n']}"
    assert r.status_code == 200
    assert SLEEPS == [1.5, 3.0], f"exponential backoff expected, got {SLEEPS}"
    print(f"  ✓ 429→429→200 recovered in {calls['n']} calls (sleeps={SLEEPS})")


def t_503_then_200_recovers() -> None:
    seq = iter([503, 200])
    calls = {"n": 0}

    def fake_get(url):
        calls["n"] += 1
        return _FakeResp(b"ok", status=next(seq))

    r = _retry_transient(fake_get, "https://x.test/", max_attempts=2)
    assert calls["n"] == 2
    assert r.status_code == 200
    print(f"  ✓ 503→200 recovered in {calls['n']} calls")


def t_404_not_retried() -> None:
    calls = {"n": 0}

    def fake_get(url):
        calls["n"] += 1
        return _FakeResp(b"", status=404)

    r = _retry_transient(fake_get, "https://x.test/", max_attempts=2)
    assert calls["n"] == 1, f"404 should not be retried, got {calls['n']} calls"
    assert r.status_code == 404
    print(f"  ✓ 404 not retried ({calls['n']} call)")


def t_200_no_retry() -> None:
    calls = {"n": 0}

    def fake_get(url):
        calls["n"] += 1
        return _FakeResp(b"ok", status=200)

    r = _retry_transient(fake_get, "https://x.test/", max_attempts=2)
    assert calls["n"] == 1
    print(f"  ✓ 200 returned immediately ({calls['n']} call)")


def t_retry_after_overrides_backoff() -> None:
    seq = iter([429, 200])

    def fake_get(url):
        return _FakeResp(b"ok", status=next(seq), headers={"Retry-After": "4"})

    SLEEPS.clear()
    r = _retry_transient(fake_get, "https://x.test/", max_attempts=2)
    assert r.status_code == 200
    assert SLEEPS == [4.0], f"Retry-After should override backoff, got {SLEEPS}"
    print(f"  ✓ Retry-After: 4 honoured over 1.5s backoff (sleeps={SLEEPS})")


def t_retry_after_capped() -> None:
    def fake_get(url):
        return _FakeResp(b"", status=429, headers={"Retry-After": "9999"})

    SLEEPS.clear()
    r = _retry_transient(fake_get, "https://x.test/", max_attempts=5)
    assert r.status_code == 429
    assert sum(SLEEPS) <= 10.0 + 1e-9, f"total sleep must be capped at 10s, got {sum(SLEEPS)}"
    print(f"  ✓ hostile Retry-After capped (total sleep={sum(SLEEPS)}s)")


def t_retry_after_parsing() -> None:
    assert _retry_after_seconds(_FakeResp(headers={"Retry-After": "7"})) == 7.0
    assert _retry_after_seconds(_FakeResp(headers={"retry-after": "2.5"})) == 2.5
    assert _retry_after_seconds(_FakeResp(headers={})) is None
    assert _retry_after_seconds(_FakeResp(headers={"Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT"})) is None
    print("  ✓ Retry-After parsing (numeric / lowercase / absent / HTTP-date)")


def t_pool_request_defaults_to_no_retry() -> None:
    sig = inspect.signature(t.SessionPool.request)
    assert sig.parameters["max_retries"].default == 0, \
        "POOL.request must default to max_retries=0 (callers opt in per request)"
    print("  ✓ POOL.request defaults to max_retries=0")


def main() -> int:
    tests = [v for k, v in sorted(globals().items()) if k.startswith("t_") and callable(v)]
    failed = 0
    for test in tests:
        try:
            test()
        except AssertionError as e:
            print(f"  ✗ {test.__name__}: {e}")
            failed += 1
    print(f"\n{'OK' if failed == 0 else 'FAIL'}: {len(tests) - failed}/{len(tests)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
