#!/usr/bin/env python3
"""U9 regression tests — cross-platform yt-dlp invocation resolution.

Deterministic and network-free. Locks in that the YouTube Phase-0 route
resolves yt-dlp robustly:
  * prefer the `yt-dlp` console script when it is on PATH,
  * fall back to `<python> -m yt_dlp` when the script dir is not on PATH but
    the module is importable (pip --user / venv / Windows), and
  * report "not installed" only when neither is available — without even
    invoking subprocess.

Regression context: on Windows and `pip install --user`, the console script
lands in a Scripts/bin dir that is commonly absent from PATH, so
`subprocess.run(["yt-dlp", ...])` raised FileNotFoundError and the route
reported "yt-dlp not installed" even though yt-dlp *was* installed and
importable — silently disabling the headline media route. references/media.md
already documents the `which yt-dlp || python3 -m yt_dlp` fallback; this locks
the same behaviour into the engine.

Run:  python3 engine/tests/test_u9.py
"""
from __future__ import annotations

import os
import sys
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, ROOT)

from engine import phase0  # noqa: E402


def t_prefers_console_script_on_path() -> None:
    with mock.patch.object(phase0.shutil, "which", return_value="/usr/bin/yt-dlp"):
        argv = phase0._ytdlp_argv()
    assert argv == ["/usr/bin/yt-dlp"], argv
    print("  ✓ console script on PATH → used directly")


def t_falls_back_to_module_when_not_on_path() -> None:
    with mock.patch.object(phase0.shutil, "which", return_value=None), \
         mock.patch.object(phase0.importlib.util, "find_spec", return_value=object()):
        argv = phase0._ytdlp_argv()
    assert argv == [sys.executable, "-m", "yt_dlp"], argv
    print("  ✓ not on PATH but importable → <python> -m yt_dlp")


def t_none_when_neither_available() -> None:
    with mock.patch.object(phase0.shutil, "which", return_value=None), \
         mock.patch.object(phase0.importlib.util, "find_spec", return_value=None):
        argv = phase0._ytdlp_argv()
    assert argv is None, argv
    print("  ✓ truly missing → None")


def t_youtube_route_reports_not_installed_without_subprocess() -> None:
    def _boom(*a, **k):
        raise AssertionError("subprocess.run must not run when yt-dlp is unavailable")
    with mock.patch.object(phase0, "_ytdlp_argv", return_value=None), \
         mock.patch.object(phase0.subprocess, "run", _boom):
        out = phase0._youtube("https://www.youtube.com/watch?v=x", timeout=5)
    assert out["ok"] is False, out
    assert out["attempts"] and out["attempts"][-1]["note"] == "yt-dlp not installed", out["attempts"]
    print("  ✓ unavailable → 'not installed' note, subprocess not invoked")


def t_youtube_route_uses_resolved_argv() -> None:
    captured = {}

    class _P:
        returncode = 0
        stdout = '{"title": "x"}'
        stderr = ""

    def _fake_run(cmd, *a, **k):
        captured["cmd"] = cmd
        return _P()

    with mock.patch.object(phase0, "_ytdlp_argv", return_value=[sys.executable, "-m", "yt_dlp"]), \
         mock.patch.object(phase0.subprocess, "run", _fake_run):
        out = phase0._youtube("https://youtu.be/abc", timeout=5)
    assert out["ok"] is True, out
    assert captured["cmd"][:3] == [sys.executable, "-m", "yt_dlp"], captured["cmd"]
    assert captured["cmd"][3:] == ["--dump-json", "--skip-download", "https://youtu.be/abc"], captured["cmd"]
    print("  ✓ resolved argv is passed through to subprocess with the yt-dlp flags")


ALL = [
    ("prefers_console_script_on_path", t_prefers_console_script_on_path),
    ("falls_back_to_module_when_not_on_path", t_falls_back_to_module_when_not_on_path),
    ("none_when_neither_available", t_none_when_neither_available),
    ("youtube_route_reports_not_installed_without_subprocess", t_youtube_route_reports_not_installed_without_subprocess),
    ("youtube_route_uses_resolved_argv", t_youtube_route_uses_resolved_argv),
]


def main() -> int:
    p = f = 0
    for name, fn in ALL:
        try:
            print(f"[{name}]")
            fn()
            p += 1
        except AssertionError as e:
            f += 1
            print(f"  ✗ FAIL: {e}")
        except Exception as e:
            f += 1
            print(f"  ✗ ERROR: {type(e).__name__}: {e}")
    print(f"\n{p} passed, {f} failed")
    return 0 if f == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
