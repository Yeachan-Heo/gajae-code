#!/usr/bin/env python3
"""Deterministic tests for 429 rate-limit backoff in fetch_chain.

All sleeps are mocked — no real delays. Tests prove:
  1. Retry-After header is read from the response and honoured (capped at 30s).
  2. Probe-phase 429 triggers backoff before the grid starts.
  3. Grid-phase 429 triggers backoff with the response, then continues.
  4. Repeated 429s remain bounded by attempt/browser budgets and terminate.
  5. Abort/timeout handling is not defeated by backoff: a cancellation
     (KeyboardInterrupt) raised during a backoff sleep propagates immediately,
     and no single backoff sleep can exceed the 30s ceiling or become
     non-finite, so a per-attempt deadline can rely on the bound and never hang.
  6. The configured base (INSANE_RATE_LIMIT_BACKOFF_S) is validated and clamped
     before sleeping: non-numeric, NaN, infinite, negative, or huge values can
     neither crash _fetch_core nor bypass the advertised 30s bound.
"""
from __future__ import annotations

import math
import os
import sys
import unittest
from unittest.mock import patch, MagicMock

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, ROOT)

from engine.fetch_chain import _fetch_core, FetchResult, _Cand  # noqa: E402
from engine.validators import Verdict  # noqa: E402


def _make_resp(status_code=429, headers=None, text="rate limited"):
    """Create a minimal fake response object."""
    resp = MagicMock()
    resp.status_code = status_code
    resp.headers = headers or {}
    resp.text = text
    resp.url = "https://example.com/page"
    return resp


def _grid_plan(n=6):
    """Return a list of n dummy grid candidates."""
    return [
        _Cand(profile_id="test", transform="original",
              url="https://example.com/page", impersonate=f"tls_{i}",
              referer="self_root", known_bad_sizes=None)
        for i in range(n)
    ]


def _run_all_429(env_value, max_attempts=4, retry_after=None):
    """Run _fetch_core where every attempt is a 429, under a given
    INSANE_RATE_LIMIT_BACKOFF_S value, with sleeps mocked.

    Returns (result, sleeps, attempt_count). Deterministic: no real network or
    delays. Used by the base-validation and timeout regressions below.
    """
    sleeps = []
    headers = {"Retry-After": retry_after} if retry_after is not None else {}
    resp_429 = _make_resp(429, headers=headers)
    call_count = [0]

    def fake_run_attempt(url, **kwargs):
        from engine.fetch_chain import Attempt
        call_count[0] += 1
        att = Attempt(phase="grid" if call_count[0] > 1 else "probe",
                      executor="curl_cffi", url=url,
                      url_transform="original", impersonate="safari",
                      referer="self_root", status=429,
                      verdict=Verdict.RATE_LIMITED.value)
        return att, resp_429

    with patch.dict(os.environ, {"INSANE_RATE_LIMIT_BACKOFF_S": env_value}, clear=False), \
         patch("engine.fetch_chain._run_attempt", side_effect=fake_run_attempt), \
         patch("engine.fetch_chain._curl_probe", return_value=(resp_429, None)), \
         patch("engine.fetch_chain.detect", return_value=[]), \
         patch("engine.fetch_chain._build_plan", return_value=_grid_plan(10)), \
         patch("engine.fetch_chain._load_profiles", return_value={}), \
         patch("engine.fetch_chain.last_load_error", return_value=None), \
         patch("engine.fetch_chain.time.sleep", side_effect=lambda d: sleeps.append(d)):
        result = _fetch_core(
            "https://example.com/page",
            enable_playwright=False,
            enable_phase0=False,
            max_attempts=max_attempts,
        )
    return result, sleeps, call_count[0]


class RateLimitBackoffUnitTest(unittest.TestCase):
    """Unit tests for the _rate_limit_backoff closure behaviour."""

    @patch("engine.fetch_chain.time.sleep")
    def test_probe_429_reads_numeric_retry_after(self, mock_sleep):
        """Probe-phase 429 with Retry-After: 10 → backoff delay >= 10."""
        sleeps = []
        mock_sleep.side_effect = lambda d: sleeps.append(d)

        resp_429 = _make_resp(429, headers={"Retry-After": "10"})
        resp_200 = _make_resp(200, text="<article>content</article>")
        call_count = [0]

        def fake_run_attempt(url, **kwargs):
            from engine.fetch_chain import Attempt
            call_count[0] += 1
            if call_count[0] == 1:
                att = Attempt(phase="probe", executor="curl_cffi", url=url,
                              url_transform="original", impersonate="safari",
                              referer="self_root", status=429,
                              verdict=Verdict.RATE_LIMITED.value)
                return att, resp_429
            att = Attempt(phase="grid", executor="curl_cffi", url=url,
                          url_transform="original", impersonate="chrome",
                          referer="self_root", status=200, body_size=100,
                          verdict=Verdict.STRONG_OK.value)
            return att, resp_200

        with patch("engine.fetch_chain._run_attempt", side_effect=fake_run_attempt), \
             patch("engine.fetch_chain._curl_probe", return_value=(resp_429, None)), \
             patch("engine.fetch_chain.detect", return_value=[]), \
             patch("engine.fetch_chain._build_plan", return_value=_grid_plan(3)), \
             patch("engine.fetch_chain._load_profiles", return_value={}), \
             patch("engine.fetch_chain.last_load_error", return_value=None), \
             patch("engine.fetch_chain.time.sleep", side_effect=lambda d: sleeps.append(d)):
            result = _fetch_core(
                "https://example.com/page",
                success_selectors=["article"],
                enable_playwright=False,
                enable_phase0=False,
                max_attempts=4,
            )

        self.assertTrue(result.ok)
        # Probe 429 backoff: delay = max(2.0*1, min(10, 30)) = 10
        rate_sleeps = [s for s in sleeps if s >= 2.0]
        self.assertTrue(len(rate_sleeps) >= 1, f"No backoff sleep found in {sleeps}")
        self.assertGreaterEqual(rate_sleeps[0], 10.0,
                                f"Retry-After:10 should produce delay>=10, got {rate_sleeps[0]}")

    @patch("engine.fetch_chain.time.sleep")
    def test_retry_after_capped_at_30s(self, mock_sleep):
        """Retry-After: 999 should be capped at 30s."""
        sleeps = []
        mock_sleep.side_effect = lambda d: sleeps.append(d)

        resp_429 = _make_resp(429, headers={"Retry-After": "999"})
        resp_200 = _make_resp(200, text="<article>ok</article>")
        call_count = [0]

        def fake_run_attempt(url, **kwargs):
            from engine.fetch_chain import Attempt
            call_count[0] += 1
            if call_count[0] == 1:
                att = Attempt(phase="probe", executor="curl_cffi", url=url,
                              url_transform="original", impersonate="safari",
                              referer="self_root", status=429,
                              verdict=Verdict.RATE_LIMITED.value)
                return att, resp_429
            att = Attempt(phase="grid", executor="curl_cffi", url=url,
                          url_transform="original", impersonate="chrome",
                          referer="self_root", status=200, body_size=50,
                          verdict=Verdict.STRONG_OK.value)
            return att, resp_200

        with patch("engine.fetch_chain._run_attempt", side_effect=fake_run_attempt), \
             patch("engine.fetch_chain._curl_probe", return_value=(resp_429, None)), \
             patch("engine.fetch_chain.detect", return_value=[]), \
             patch("engine.fetch_chain._build_plan", return_value=_grid_plan(3)), \
             patch("engine.fetch_chain._load_profiles", return_value={}), \
             patch("engine.fetch_chain.last_load_error", return_value=None), \
             patch("engine.fetch_chain.time.sleep", side_effect=lambda d: sleeps.append(d)):
            _fetch_core(
                "https://example.com/page",
                success_selectors=["article"],
                enable_playwright=False,
                enable_phase0=False,
                max_attempts=4,
            )

        for s in sleeps:
            self.assertLessEqual(s, 30.0, f"Sleep {s} exceeds 30s cap")

    @patch("engine.fetch_chain.time.sleep")
    def test_grid_429_passes_response_to_backoff(self, mock_sleep):
        """Grid-phase 429 must pass resp so Retry-After is read."""
        sleeps = []
        mock_sleep.side_effect = lambda d: sleeps.append(d)

        resp_challenge = _make_resp(403, text="blocked")
        resp_429 = _make_resp(429, headers={"Retry-After": "7"})
        resp_200 = _make_resp(200, text="<article>ok</article>")
        call_count = [0]

        def fake_run_attempt(url, **kwargs):
            from engine.fetch_chain import Attempt
            call_count[0] += 1
            if call_count[0] == 1:
                att = Attempt(phase="probe", executor="curl_cffi", url=url,
                              url_transform="original", impersonate="safari",
                              referer="self_root", status=403,
                              verdict=Verdict.CHALLENGE.value)
                return att, resp_challenge
            elif call_count[0] == 2:
                att = Attempt(phase="grid", executor="curl_cffi", url=url,
                              url_transform="original", impersonate="chrome",
                              referer="self_root", status=429,
                              verdict=Verdict.RATE_LIMITED.value)
                return att, resp_429
            else:
                att = Attempt(phase="grid", executor="curl_cffi", url=url,
                              url_transform="original", impersonate="firefox",
                              referer="self_root", status=200, body_size=50,
                              verdict=Verdict.STRONG_OK.value)
                return att, resp_200

        with patch("engine.fetch_chain._run_attempt", side_effect=fake_run_attempt), \
             patch("engine.fetch_chain._curl_probe", return_value=(resp_challenge, None)), \
             patch("engine.fetch_chain.detect", return_value=[]), \
             patch("engine.fetch_chain._build_plan", return_value=_grid_plan(4)), \
             patch("engine.fetch_chain._load_profiles", return_value={}), \
             patch("engine.fetch_chain.last_load_error", return_value=None), \
             patch("engine.fetch_chain.time.sleep", side_effect=lambda d: sleeps.append(d)):
            result = _fetch_core(
                "https://example.com/page",
                success_selectors=["article"],
                enable_playwright=False,
                enable_phase0=False,
                max_attempts=5,
            )

        self.assertTrue(result.ok)
        # Grid 429 backoff: delay = max(2.0*1, min(7, 30)) = 7
        rate_sleeps = [s for s in sleeps if s >= 2.0]
        self.assertTrue(any(s >= 7.0 for s in rate_sleeps),
                        f"Expected a sleep >= 7 from Retry-After:7, got {sleeps}")


class RateLimitBudgetTerminationTest(unittest.TestCase):
    """Repeated 429s must terminate within the attempt budget."""

    @patch("engine.fetch_chain.time.sleep")
    def test_all_429s_terminate_within_budget(self, mock_sleep):
        """If every attempt is 429, the grid must stop at max_attempts."""
        sleeps = []
        mock_sleep.side_effect = lambda d: sleeps.append(d)

        resp_429 = _make_resp(429, headers={"Retry-After": "1"})
        call_count = [0]

        def fake_run_attempt(url, **kwargs):
            from engine.fetch_chain import Attempt
            call_count[0] += 1
            att = Attempt(phase="grid" if call_count[0] > 1 else "probe",
                          executor="curl_cffi", url=url,
                          url_transform="original", impersonate="safari",
                          referer="self_root", status=429,
                          verdict=Verdict.RATE_LIMITED.value)
            return att, resp_429

        with patch("engine.fetch_chain._run_attempt", side_effect=fake_run_attempt), \
             patch("engine.fetch_chain._curl_probe", return_value=(resp_429, None)), \
             patch("engine.fetch_chain.detect", return_value=[]), \
             patch("engine.fetch_chain._build_plan", return_value=_grid_plan(10)), \
             patch("engine.fetch_chain._load_profiles", return_value={}), \
             patch("engine.fetch_chain.last_load_error", return_value=None), \
             patch("engine.fetch_chain.time.sleep", side_effect=lambda d: sleeps.append(d)):
            result = _fetch_core(
                "https://example.com/page",
                enable_playwright=False,
                enable_phase0=False,
                max_attempts=4,
            )

        self.assertFalse(result.ok)
        # Budget of 4 means at most 4 curl attempts (1 probe + 3 grid)
        self.assertLessEqual(call_count[0], 4,
                             f"Expected <= 4 attempts, got {call_count[0]}")
        self.assertIn(result.stop_reason, ("budget", "exhausted", "rate_limited"))

    @patch("engine.fetch_chain.time.sleep")
    def test_429_does_not_defeat_browser_fallback(self, mock_sleep):
        """After grid 429s exhaust budget, Playwright fallback is still attempted."""
        mock_sleep.side_effect = lambda d: None

        resp_429 = _make_resp(429)
        call_count = [0]

        def fake_run_attempt(url, **kwargs):
            from engine.fetch_chain import Attempt
            call_count[0] += 1
            att = Attempt(phase="grid" if call_count[0] > 1 else "probe",
                          executor="curl_cffi", url=url,
                          url_transform="original", impersonate="safari",
                          referer="self_root", status=429,
                          verdict=Verdict.RATE_LIMITED.value)
            return att, resp_429

        pw_called = [False]

        def fake_playwright(url, **kwargs):
            from engine.fetch_chain import Attempt
            pw_called[0] = True
            att = Attempt(phase="fallback", executor="playwright_real_chrome",
                          url=url, url_transform="original", impersonate=None,
                          referer="", status=200, body_size=500,
                          verdict=Verdict.STRONG_OK.value)
            return att, "<article>browser content</article>"

        with patch("engine.fetch_chain._run_attempt", side_effect=fake_run_attempt), \
             patch("engine.fetch_chain._curl_probe", return_value=(resp_429, None)), \
             patch("engine.fetch_chain.detect", return_value=[]), \
             patch("engine.fetch_chain._build_plan", return_value=_grid_plan(5)), \
             patch("engine.fetch_chain._load_profiles", return_value={}), \
             patch("engine.fetch_chain.last_load_error", return_value=None), \
             patch("engine.fetch_chain.load_profile", return_value={"fallback_when_challenge": ["playwright_real_chrome"]}), \
             patch("engine.fetch_chain.time.sleep", side_effect=lambda d: None):
            with patch.dict("sys.modules", {"engine.executor": MagicMock(run_playwright_fallback=fake_playwright)}):
                result = _fetch_core(
                    "https://example.com/page",
                    success_selectors=["article"],
                    enable_playwright=True,
                    enable_phase0=False,
                    max_attempts=3,
                )

        # 429 is NOT terminal → browser fallback must be attempted
        self.assertTrue(pw_called[0], "Playwright fallback was not attempted after 429s")
        self.assertTrue(result.ok)
        self.assertEqual(result.stop_reason, "success")

    @patch("engine.fetch_chain.time.sleep")
    def test_backoff_linear_escalation(self, mock_sleep):
        """Backoff delay escalates linearly: base*1, base*2, ..., base*5 cap."""
        sleeps = []
        mock_sleep.side_effect = lambda d: sleeps.append(d)

        resp_429 = _make_resp(429)  # no Retry-After header
        call_count = [0]

        def fake_run_attempt(url, **kwargs):
            from engine.fetch_chain import Attempt
            call_count[0] += 1
            att = Attempt(phase="grid" if call_count[0] > 1 else "probe",
                          executor="curl_cffi", url=url,
                          url_transform="original", impersonate="safari",
                          referer="self_root", status=429,
                          verdict=Verdict.RATE_LIMITED.value)
            return att, resp_429

        with patch("engine.fetch_chain._run_attempt", side_effect=fake_run_attempt), \
             patch("engine.fetch_chain._curl_probe", return_value=(resp_429, None)), \
             patch("engine.fetch_chain.detect", return_value=[]), \
             patch("engine.fetch_chain._build_plan", return_value=_grid_plan(10)), \
             patch("engine.fetch_chain._load_profiles", return_value={}), \
             patch("engine.fetch_chain.last_load_error", return_value=None), \
             patch("engine.fetch_chain.time.sleep", side_effect=lambda d: sleeps.append(d)):
            _fetch_core(
                "https://example.com/page",
                enable_playwright=False,
                enable_phase0=False,
                max_attempts=7,  # 1 probe + 6 grid = 7 backoff sleeps
            )

        # Filter to backoff sleeps (>= 2.0 base) — jitter sleeps are < 0.4
        backoff_sleeps = [s for s in sleeps if s >= 2.0]
        # Expect linear: 2, 4, 6, 8, 10, 10 (capped at count=5)
        expected = [2.0, 4.0, 6.0, 8.0, 10.0, 10.0]
        self.assertEqual(backoff_sleeps[:6], expected,
                         f"Expected linear escalation {expected}, got {backoff_sleeps}")


class RateLimitBaseValidationTest(unittest.TestCase):
    """The configured backoff base must be validated/clamped before sleeping.

    Regression for the review finding that `_rl_base = float(env)` was neither
    validated nor capped, so a large/negative/NaN/infinite/non-numeric value
    could bypass the 30s bound, hang time.sleep, or crash _fetch_core.
    """

    def test_clamp_helper_rejects_pathological_values(self):
        """_clamp_rate_limit_base is total: never raises, always safe & bounded."""
        from engine.fetch_chain import (
            _clamp_rate_limit_base, _RATE_LIMIT_MAX_DELAY, _RATE_LIMIT_DEFAULT_BASE,
        )
        # Non-numeric / NaN / infinite / negative / empty / None -> default.
        for bad in ["abc", "nan", "inf", "-inf", "-5", "-0.1", "", "  ", None]:
            base = _clamp_rate_limit_base(bad)
            self.assertEqual(base, _RATE_LIMIT_DEFAULT_BASE,
                             f"{bad!r} should fall back to default, got {base}")
        # Valid values pass through, clamped to the ceiling.
        self.assertEqual(_clamp_rate_limit_base("2.0"), 2.0)
        self.assertEqual(_clamp_rate_limit_base("7"), 7.0)
        self.assertEqual(_clamp_rate_limit_base("0"), 0.0)
        self.assertEqual(_clamp_rate_limit_base("30"), _RATE_LIMIT_MAX_DELAY)
        self.assertEqual(_clamp_rate_limit_base("999"), _RATE_LIMIT_MAX_DELAY)
        self.assertEqual(_clamp_rate_limit_base("1e308"), _RATE_LIMIT_MAX_DELAY)
        # Result is always finite and within [0, ceiling].
        for v in ["abc", "nan", "inf", "-5", "1e308", "2.0", "999", None]:
            b = _clamp_rate_limit_base(v)
            self.assertTrue(math.isfinite(b), f"non-finite base for {v!r}: {b}")
            self.assertGreaterEqual(b, 0.0)
            self.assertLessEqual(b, _RATE_LIMIT_MAX_DELAY)

    def test_huge_env_base_capped_end_to_end(self):
        """A huge base must not produce a sleep beyond the 30s ceiling."""
        _, sleeps, _ = _run_all_429("1000000000", max_attempts=4)
        self.assertTrue(sleeps, "expected at least one backoff sleep")
        for s in sleeps:
            self.assertTrue(math.isfinite(s), f"non-finite sleep {s!r}")
            self.assertLessEqual(s, 30.0, f"huge base produced sleep {s!r} > 30s")

    def test_negative_env_base_no_crash_no_negative_sleep(self):
        """A negative base must not raise nor hand time.sleep a negative value."""
        _, sleeps, _ = _run_all_429("-5", max_attempts=4)  # must not raise
        for s in sleeps:
            self.assertGreaterEqual(s, 0.0, f"negative sleep {s!r}")
            self.assertLessEqual(s, 30.0)

    def test_nan_env_base_no_crash(self):
        """A NaN base must not crash nor produce a non-finite sleep."""
        _, sleeps, _ = _run_all_429("nan", max_attempts=4)  # must not raise
        for s in sleeps:
            self.assertTrue(math.isfinite(s), f"non-finite sleep {s!r}")
            self.assertLessEqual(s, 30.0)

    def test_infinite_env_base_does_not_hang(self):
        """An infinite base must not produce an infinite (hanging) sleep."""
        _, sleeps, _ = _run_all_429("inf", max_attempts=4)  # must not raise/hang
        for s in sleeps:
            self.assertTrue(math.isfinite(s), f"infinite sleep {s!r} would hang")
            self.assertLessEqual(s, 30.0)

    def test_nonnumeric_env_base_no_crash(self):
        """A non-numeric base must not raise ValueError inside _fetch_core."""
        result, _, n = _run_all_429("not-a-number", max_attempts=4)  # must not raise
        self.assertFalse(result.ok)
        self.assertGreaterEqual(n, 1)


class RateLimitCancellationTest(unittest.TestCase):
    """Abort/timeout handling must not be defeated by backoff (header claim 5)."""

    def test_keyboardinterrupt_during_backoff_propagates(self):
        """A cancellation raised during a backoff sleep propagates immediately;
        backoff neither swallows it nor keeps the grid running."""
        resp_429 = _make_resp(429, headers={"Retry-After": "10"})
        call_count = [0]

        def fake_run_attempt(url, **kwargs):
            from engine.fetch_chain import Attempt
            call_count[0] += 1
            att = Attempt(phase="probe", executor="curl_cffi", url=url,
                          url_transform="original", impersonate="safari",
                          referer="self_root", status=429,
                          verdict=Verdict.RATE_LIMITED.value)
            return att, resp_429

        def cancelling_sleep(d):
            raise KeyboardInterrupt()

        with patch("engine.fetch_chain._run_attempt", side_effect=fake_run_attempt), \
             patch("engine.fetch_chain._curl_probe", return_value=(resp_429, None)), \
             patch("engine.fetch_chain._load_profiles", return_value={}), \
             patch("engine.fetch_chain.last_load_error", return_value=None), \
             patch("engine.fetch_chain.time.sleep", side_effect=cancelling_sleep):
            with self.assertRaises(KeyboardInterrupt):
                _fetch_core(
                    "https://example.com/page",
                    enable_playwright=False,
                    enable_phase0=False,
                    max_attempts=6,
                )
        # Cancellation fired on the first backoff and stopped the chain before
        # the grid could run to its budget — the abort was honoured promptly.
        self.assertLess(call_count[0], 6,
                        f"cancellation should cut the chain short, ran {call_count[0]}")

    def test_per_sleep_bound_holds_under_pathological_inputs(self):
        """Timeout regression: even with a huge base AND a huge Retry-After, no
        single backoff sleep may exceed the 30s ceiling or become non-finite,
        so a per-attempt deadline can rely on the bound and never hang."""
        result, sleeps, _ = _run_all_429("1e9", max_attempts=5, retry_after="999999")
        self.assertTrue(sleeps, "expected at least one backoff sleep")
        for s in sleeps:
            self.assertTrue(math.isfinite(s), f"non-finite sleep {s!r}")
            self.assertGreaterEqual(s, 0.0, f"negative sleep {s!r}")
            self.assertLessEqual(s, 30.0, f"sleep {s!r} exceeds the 30s ceiling")
        # The chain still terminates within budget (it was not hung).
        self.assertFalse(result.ok)


if __name__ == "__main__":
    unittest.main()
