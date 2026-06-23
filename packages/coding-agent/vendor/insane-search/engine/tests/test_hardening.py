#!/usr/bin/env python3
from __future__ import annotations

import os
import subprocess
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, ROOT)

from engine.fetch_chain import FetchResult  # noqa: E402
from engine.transport import SessionPool  # noqa: E402


class FetchResultJsonContractTest(unittest.TestCase):
    def test_to_dict_omits_content_by_default_but_reports_length(self):
        payload = FetchResult(ok=True, content="recovered").to_dict()
        self.assertNotIn("content", payload)
        self.assertEqual(payload["content_length"], len("recovered"))
        self.assertFalse(payload["content_truncated"])

    def test_to_dict_includes_bounded_content_for_cli_json(self):
        payload = FetchResult(ok=True, content="abcdef").to_dict(include_content=True, content_limit=3)
        self.assertEqual(payload["content"], "abc")
        self.assertEqual(payload["content_length"], 6)
        self.assertTrue(payload["content_truncated"])


class RedirectSafetyTest(unittest.TestCase):
    def test_transport_redirect_to_private_target_is_blocked(self):
        class Resp:
            status_code = 302
            headers = {"Location": "http://127.0.0.1/private"}
            text = ""
            url = "https://public.example/redirect"

        resp, err = SessionPool._fetch_following(lambda _url: Resp(), "https://public.example/redirect", False, 10, None)
        self.assertIsNone(resp)
        self.assertTrue(err.startswith("ssrf_redirect_blocked:"), err)

    def test_playwright_templates_reject_private_initial_url_before_browser_launch(self):
        template = os.path.join(ROOT, "engine", "templates", "playwright_real_chrome.js")
        proc = subprocess.run(
            ["node", template],
            input='{"url":"http://127.0.0.1/private"}',
            capture_output=True,
            text=True,
            timeout=10,
        )
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("unsafe_url", proc.stderr)


if __name__ == "__main__":
    unittest.main()
