#!/usr/bin/env python3
"""Regression tests — content-rescue extraction (PDF / JSON-LD / render-merge).

Deterministic, network-free. Locks in:
  * ordinary HTML success keeps the RAW body (source=raw) — no contract break
  * JSON-LD articleBody rescues an SPA shell whose visible text is thin
  * a JSON-LD teaser NEVER beats a full article body (the gate that kept the
    og:description class of bug out of this chain)
  * PDF magic bytes detected even under a wrong text/html content-type
  * a .pdf URL that serves plain HTML is re-guarded back to the HTML path
  * blank PDF → pdf_no_text_layer (skipped when pypdf is unavailable)
  * render-merge: innerText wins for an SPA shell, loses to a rich body
  * enable_extraction=False returns raw text (source=raw_disabled)
  * FetchResult carries extraction_quality / extraction_source / extraction_meta

Run:  python3 engine/tests/test_t2_rescue.py
"""
from __future__ import annotations

import io
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, ROOT)

from engine.fetch_chain import (  # noqa: E402
    FetchResult,
    _extract_pdf,
    _extract_response,
    _looks_like_pdf,
    _maybe_extract,
    _quality_score,
)


class _FakeResp:
    def __init__(self, text="", content=None, headers=None, url="https://x.test/"):
        self.text = text
        self.content = content if content is not None else text.encode("utf-8", "ignore")
        self.headers = headers or {"content-type": "text/html"}
        self.status_code = 200
        self.url = url


_ARTICLE = ("<html><head><title>Full Article</title></head><body><article><p>"
            + ("This is a full article sentence with real substance. " * 60)
            + "</p></article>"
            '<script type="application/ld+json">'
            '{"@type":"NewsArticle","description":"One-line teaser blurb."}'
            "</script></body></html>")

_SHELL_WITH_JSONLD = ('<html><head><title>Shell</title></head><body>'
                      '<div id="root"></div>'
                      '<script type="application/ld+json">'
                      '{"@type":"NewsArticle","articleBody":"'
                      + ("Real article body only present in JSON-LD. " * 20)
                      + '"}</script></body></html>')


def t_raw_body_wins_for_ordinary_html() -> None:
    title, content, q, meta = _extract_response(_FakeResp(_ARTICLE), "https://x.test/a")
    assert meta["source"] == "raw", f"got {meta['source']}"
    assert content == _ARTICLE, "ordinary HTML must keep the raw body"
    assert title == "Full Article"
    print(f"  ✓ ordinary HTML keeps raw body (q={q})")


def t_jsonld_rescues_thin_shell() -> None:
    title, content, q, meta = _extract_response(
        _FakeResp(_SHELL_WITH_JSONLD), "https://x.test/shell")
    assert meta["source"] == "json_ld", f"got {meta['source']}"
    assert "Real article body" in content
    print(f"  ✓ SPA shell rescued by JSON-LD articleBody (len={len(content)})")


def t_jsonld_teaser_never_beats_full_article() -> None:
    # _ARTICLE carries an 11-word JSON-LD description teaser next to a full
    # body — the teaser must NOT replace the article.
    _t, content, _q, meta = _extract_response(_FakeResp(_ARTICLE), "https://x.test/a")
    assert meta["source"] == "raw" and "teaser" not in content[:200], \
        f"teaser must not beat full body; got source={meta['source']}"
    print("  ✓ JSON-LD teaser gated out when full body present")


def t_pdf_magic_byte_detection() -> None:
    r = _FakeResp(text="", content=b"%PDF-1.4\n%binary garbage",
                  headers={"content-type": "text/html"})
    assert _looks_like_pdf(r, "https://x.test/doc.pdf") is True
    assert _looks_like_pdf(r, "https://x.test/doc") is True  # magic bytes alone suffice
    print("  ✓ %PDF- magic bytes detected despite text/html content-type")


def t_pdf_url_serving_html_reguarded() -> None:
    # .pdf URL but the body is HTML (e.g. a viewer page) → HTML path, not pypdf.
    r = _FakeResp(text=_ARTICLE, headers={"content-type": "text/html"})
    _t, content, _q, meta = _extract_response(r, "https://x.test/doc.pdf")
    assert meta["source"] == "raw", f".pdf URL with HTML body must stay HTML; got {meta['source']}"
    assert content == _ARTICLE
    print("  ✓ .pdf URL serving HTML re-guarded to the HTML path")


def t_pdf_extraction_through_pypdf() -> None:
    try:
        from pypdf import PdfWriter
    except ImportError:
        print("  ⚠ skipped: pypdf not installed")
        return
    writer = PdfWriter()
    writer.add_blank_page(width=200, height=200)
    buf = io.BytesIO()
    writer.write(buf)
    title, text, q, err = _extract_pdf(buf.getvalue(), "https://x.test/blank.pdf")
    assert err == "pdf_no_text_layer", f"got {err}"
    assert text == ""
    print(f"  ✓ blank PDF → pdf_no_text_layer (err={err})")


def t_inner_text_wins_for_shell() -> None:
    shell = "<html><body><div id='root'></div></body></html>"
    inner = "Real visible text harvested from innerText. " * 20
    _t, content, _q, meta = _extract_response(
        _FakeResp(shell), "https://x.test/x", inner_text=inner)
    assert meta["inner_text_used"] is True, f"innerText should win for SPA shell; meta={meta}"
    assert meta["source"].endswith("+inner_text")
    assert len(content) > 200
    print(f"  ✓ render-merge: innerText wins for SPA shell (len={len(content)})")


def t_inner_text_loses_to_rich_body() -> None:
    inner = "Short cookie banner text."
    _t, content, _q, meta = _extract_response(
        _FakeResp(_ARTICLE), "https://x.test/a", inner_text=inner)
    assert meta["inner_text_used"] is False, "thin innerText must not clobber a rich body"
    assert content == _ARTICLE
    print("  ✓ render-merge: thin innerText never clobbers a rich body")


def t_extraction_disabled_returns_raw() -> None:
    _t, content, q, meta = _maybe_extract(
        _FakeResp(_SHELL_WITH_JSONLD), "https://x.test/s", enable_extraction=False)
    assert meta["source"] == "raw_disabled" and content == _SHELL_WITH_JSONLD and q == 0.0
    print("  ✓ enable_extraction=False → raw body (source=raw_disabled)")


def t_quality_score_bounds() -> None:
    assert _quality_score("") == 0.0
    assert 0.0 <= _quality_score("Short.") <= 1.0
    q = _quality_score("This is a sentence. " * 100)
    assert 0.0 <= q <= 1.0
    print(f"  ✓ quality score in [0, 1] (long md → {q})")


def t_fetch_result_carries_extraction_meta() -> None:
    r = FetchResult(
        ok=True, content="hello",
        extraction_quality=0.7,
        extraction_source="json_ld",
        extraction_meta={"source": "json_ld", "inner_text_used": False},
    )
    d = r.to_dict()
    assert d["extraction_quality"] == 0.7
    assert d["extraction_source"] == "json_ld"
    assert d["extraction_meta"]["source"] == "json_ld"
    print("  ✓ FetchResult.to_dict exposes extraction_*")


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
