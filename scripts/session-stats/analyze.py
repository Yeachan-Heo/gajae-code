#!/usr/bin/env python3
"""
Analyses over the session-stats sqlite tables (`ss_*`) populated by sync.py.

Subcommands:
  tools       — per-tool token totals (port of cmd_tools.rs)
  edits       — edit-tool reliability audit (port of cmd_edits.rs)

Each subcommand reads from ~/.gjc/stats.db. Run sync.py first.
"""

from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
from collections import Counter, defaultdict
from pathlib import Path

DB_PATH = Path.home() / ".gjc" / "stats.db"


# --------------------------------------------------------------------------- #
# Shared helpers

def open_ro() -> sqlite3.Connection:
    if not DB_PATH.exists():
        sys.exit(f"db not found: {DB_PATH}. Run sync.py first.")
    conn = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def commas(n: int) -> str:
    return f"{n:,}"


def pct(part: int, total: int) -> float:
    return 0.0 if total == 0 else (100.0 * part / total)


def truncate_line(s: str, n: int) -> str:
    s = s.replace("\n", " | ")
    if len(s) <= n:
        return s
    return s[: n - 1] + "…"


def parse_bucket(spec: str) -> int:
    """`h`,`d`,`w`,`m`,`<N>h`,`<N>d`,`<N>w` -> seconds."""
    units = {"h": 3600, "d": 86400, "w": 604800, "m": 2592000}
    if spec in units:
        return units[spec]
    if spec[-1] in units and spec[:-1].isdigit():
        return int(spec[:-1]) * units[spec[-1]]
    if spec == "hour":
        return 3600
    if spec == "day":
        return 86400
    if spec == "week":
        return 604800
    raise ValueError(f"bad --by spec: {spec}")


def percentile(values: list[int], p: float) -> float:
    if not values:
        return 0.0
    s = sorted(values)
    k = (len(s) - 1) * (p / 100.0)
    lo, hi = int(k), min(int(k) + 1, len(s) - 1)
    if lo == hi:
        return float(s[lo])
    return s[lo] + (s[hi] - s[lo]) * (k - lo)


# --------------------------------------------------------------------------- #
# `tools` — per-tool token totals (cmd_tools.rs port)

TOOLS_AGGREGATE_SQL = """
WITH per_tool AS (
    SELECT
        c.tool_name,
        COUNT(*)                       AS calls,
        IFNULL(SUM(c.arg_tokens), 0)   AS arg_tok
    FROM ss_tool_calls c
    GROUP BY c.tool_name
),
per_tool_res AS (
    SELECT
        r.tool_name,
        COUNT(*)                       AS results,
        IFNULL(SUM(r.result_tokens),0) AS res_tok
    FROM ss_tool_results r
    GROUP BY r.tool_name
)
SELECT
    COALESCE(p.tool_name, q.tool_name) AS tool_name,
    IFNULL(p.calls, 0)                 AS calls,
    IFNULL(q.results, 0)               AS results,
    IFNULL(p.arg_tok, 0)               AS arg_tok,
    IFNULL(q.res_tok, 0)               AS res_tok
FROM per_tool p FULL OUTER JOIN per_tool_res q USING (tool_name)
ORDER BY (IFNULL(p.arg_tok, 0) + IFNULL(q.res_tok, 0)) DESC
"""


def cmd_tools(args: argparse.Namespace) -> int:
    conn = open_ro()
    where_session, where_args = _session_filter_clause(conn, args)

    def with_session(table_alias: str) -> tuple[str, tuple]:
        """Returns ('AND <alias>.session_file IN (...)', params) or ('', ())."""
        if not where_args:
            return "", ()
        ph = ",".join("?" * len(where_args))
        return f"AND {table_alias}.session_file IN ({ph})", where_args

    sf_clause_c, sf_params_c = with_session("c")
    sf_clause_r, sf_params_r = with_session("r")
    sf_clause_a, sf_params_a = with_session("a")
    sf_clause_u, sf_params_u = with_session("u")

    # Grand totals (each subquery applies its own session filter).
    grand = conn.execute(
        f"""
        SELECT
          (SELECT IFNULL(SUM(c.arg_tokens),0)      FROM ss_tool_calls     c WHERE 1=1 {sf_clause_c}) AS tool_args,
          (SELECT IFNULL(SUM(r.result_tokens),0)   FROM ss_tool_results   r WHERE 1=1 {sf_clause_r}) AS tool_res,
          (SELECT IFNULL(SUM(a.thinking_tokens),0) FROM ss_assistant_msgs a WHERE 1=1 {sf_clause_a}) AS thinking,
          (SELECT IFNULL(SUM(a.text_tokens),0)     FROM ss_assistant_msgs a WHERE 1=1 {sf_clause_a}) AS asst_text,
          (SELECT IFNULL(SUM(u.text_tokens),0)     FROM ss_user_msgs      u WHERE 1=1 {sf_clause_u}) AS user_text,
          (SELECT COUNT(*)                         FROM ss_tool_calls     c WHERE 1=1 {sf_clause_c}) AS n_calls,
          (SELECT COUNT(*)                         FROM ss_tool_results   r WHERE 1=1 {sf_clause_r}) AS n_results
        """,
        sf_params_c + sf_params_r + sf_params_a + sf_params_a + sf_params_u + sf_params_c + sf_params_r,
    ).fetchone()
    n_sessions = conn.execute(
        f"SELECT COUNT(*) FROM ss_sessions {where_session}", where_args
    ).fetchone()[0]
    g = grand

    grand_total = g["tool_args"] + g["tool_res"] + g["thinking"] + g["asst_text"] + g["user_text"]
    print("=== grand totals ===")
    print(f"sessions:               {commas(n_sessions)}")
    print(f"tool calls / results:   {commas(g['n_calls'])} / {commas(g['n_results'])}")
    print(f"tool ARGS tokens:       {commas(g['tool_args']):>14}  ({pct(g['tool_args'], grand_total):5.1f}%)")
    print(f"tool RESULTS tokens:    {commas(g['tool_res']):>14}  ({pct(g['tool_res'], grand_total):5.1f}%)")
    print(f"assistant THINKING:     {commas(g['thinking']):>14}  ({pct(g['thinking'], grand_total):5.1f}%)")
    print(f"assistant TEXT:         {commas(g['asst_text']):>14}  ({pct(g['asst_text'], grand_total):5.1f}%)")
    print(f"user TEXT:              {commas(g['user_text']):>14}  ({pct(g['user_text'], grand_total):5.1f}%)")
    print(f"total:                  {commas(grand_total):>14}")

    # Per-tool table.
    rows = conn.execute(
        f"""
        WITH per_tool AS (
          SELECT c.tool_name, COUNT(*) AS calls, IFNULL(SUM(c.arg_tokens),0) AS arg_tok
          FROM ss_tool_calls c WHERE 1=1 {sf_clause_c}
          GROUP BY c.tool_name
        ),
        per_tool_res AS (
          SELECT r.tool_name, COUNT(*) AS results, IFNULL(SUM(r.result_tokens),0) AS res_tok
          FROM ss_tool_results r WHERE 1=1 {sf_clause_r}
          GROUP BY r.tool_name
        )
        SELECT
          COALESCE(p.tool_name, q.tool_name) AS tool_name,
          IFNULL(p.calls,0) AS calls, IFNULL(q.results,0) AS results,
          IFNULL(p.arg_tok,0) AS arg_tok, IFNULL(q.res_tok,0) AS res_tok
        FROM per_tool p FULL OUTER JOIN per_tool_res q USING (tool_name)
        ORDER BY (IFNULL(p.arg_tok,0) + IFNULL(q.res_tok,0)) DESC
        """,
        sf_params_c + sf_params_r,
    ).fetchall()

    print("\n=== per-tool tokens ===")
    print(f"{'tool':<24} {'calls':>7} {'args':>14} {'results':>14} {'total':>14}")
    print("-" * 78)
    for r in rows:
        total = r["arg_tok"] + r["res_tok"]
        print(
            f"{r['tool_name']:<24} {r['calls']:>7} "
            f"{commas(r['arg_tok']):>14} {commas(r['res_tok']):>14} {commas(total):>14}"
        )

    if args.by:
        bucket = parse_bucket(args.by)
        _print_buckets(conn, bucket, args.top, args.tool)

    return 0


def _session_filter_clause(conn, args) -> tuple[str, tuple]:
    """Builds an optional WHERE clause for session_file filtering by --limit / --folder."""
    clauses, params = [], []
    if args.folder:
        clauses.append("folder LIKE ?")
        params.append(f"%{args.folder}%")
    if args.limit > 0:
        # Resolve to a concrete session_file IN (...) so other tables can reuse it.
        rows = conn.execute(
            f"""
            SELECT session_file FROM ss_sessions
            {('WHERE ' + ' AND '.join(clauses)) if clauses else ''}
            ORDER BY mtime DESC LIMIT ?
            """,
            (*params, args.limit),
        ).fetchall()
        files = [r[0] for r in rows]
        if not files:
            return ("WHERE 0", ())
        placeholders = ",".join("?" * len(files))
        return (f"WHERE session_file IN ({placeholders})", tuple(files))
    if clauses:
        return ("WHERE " + " AND ".join(clauses), tuple(params))
    return ("", ())


def _print_buckets(conn, bucket_secs: int, top: int, tool_filter: str | None) -> None:
    where = "WHERE c.tool_name = ?" if tool_filter else ""
    params = (tool_filter,) if tool_filter else ()
    rows = conn.execute(
        f"""
        SELECT
          (c.timestamp / 1000 / ?) * ? AS bucket,
          c.tool_name,
          COUNT(*)                                 AS calls,
          IFNULL(SUM(c.arg_tokens), 0)             AS arg_tok,
          IFNULL(SUM(r.result_tokens), 0)          AS res_tok
        FROM ss_tool_calls c
        LEFT JOIN ss_tool_results r
          ON r.session_file = c.session_file AND r.call_id = c.call_id
        {where}
        GROUP BY bucket, c.tool_name
        ORDER BY bucket DESC
        """,
        (bucket_secs, bucket_secs) + params,
    ).fetchall()

    by_bucket: dict[int, list[sqlite3.Row]] = defaultdict(list)
    for r in rows:
        by_bucket[r["bucket"]].append(r)

    print(f"\n=== per-tool tokens, bucketed by {bucket_secs}s "
          f"({'all tools' if not tool_filter else tool_filter}) ===")
    for bucket in sorted(by_bucket.keys(), reverse=True)[:20]:
        from datetime import datetime, timezone
        label = datetime.fromtimestamp(bucket, tz=timezone.utc).strftime("%Y-%m-%d %H:%MZ")
        print(f"\n[{label}]")
        ranked = sorted(by_bucket[bucket], key=lambda r: -(r["arg_tok"] + r["res_tok"]))
        for r in ranked[:top]:
            tot = r["arg_tok"] + r["res_tok"]
            print(f"  {r['tool_name']:<22} {r['calls']:>5}c "
                  f"args={commas(r['arg_tok']):>12} res={commas(r['res_tok']):>12} "
                  f"tot={commas(tot):>12}")


# --------------------------------------------------------------------------- #
# `edits` — edit-tool reliability audit (cmd_edits.rs port)

_RE_TRUNCATED = re.compile(r"\[Output truncated", re.I)
_RE_ABORTED = re.compile(
    r"Tool execution was aborted|Request was aborted|cancelled|canceled by user", re.I
)
_RE_SUCCESS = re.compile(
    r"^(Updated|Successfully (wrote|replaced|edited|deleted|inserted)|Replaced|"
    r"Applied|Deleted|Created|Wrote|edit applied|Edited|Inserted|OK\b)",
    re.I,
)
_RE_ANCHOR_STALE = re.compile(
    r"(Edit rejected:.*anchor[s]? do(es)? not match the current file|"
    r"Edit rejected:.*line[s]? .* changed since the last read|"
    r"line[s]? ha(s|ve) changed since last read)",
    re.I,
)
_RE_ANCHOR_MISSING = re.compile(
    r"anchor .* (not found|unknown|missing)|loc requires the full anchor", re.I
)
_RE_NO_ENCLOSING = re.compile(r"No enclosing .* block", re.I)
_RE_PARSE_ERROR = re.compile(r"parse|syntax error|unbalanced|unexpected token", re.I)
_RE_SSR_NO_MATCH = re.compile(
    r"0 matches|no replacements|no match found|No replacements made|Failed to find expected lines",
    re.I,
)
_RE_FILE_NOT_READ = re.compile(r"must be read first|has not been read|not yet read", re.I)
_RE_FILE_CHANGED = re.compile(r"file has been (modified|changed) externally", re.I)
_RE_PERM_DENIED = re.compile(r"permission denied|not allowed", re.I)
_RE_GENERIC_REJECTED = re.compile(r"\b(rejected|failed|error|invalid)\b", re.I)


def classify_edit_result(text: str) -> str:
    t = (text or "").strip()
    if not t:
        return "empty"
    first = t.split("\n", 1)[0]
    if _RE_TRUNCATED.search(first):
        return "truncated"
    if _RE_ABORTED.search(t):
        return "aborted"
    if _RE_SUCCESS.match(first):
        return "success"
    if _RE_ANCHOR_STALE.search(t):
        return "fail:anchor-stale"
    if _RE_NO_ENCLOSING.search(t):
        return "fail:no-enclosing-block"
    if _RE_ANCHOR_MISSING.search(t):
        return "fail:anchor-missing"
    if _RE_PARSE_ERROR.search(t):
        return "fail:parse"
    if _RE_SSR_NO_MATCH.search(t):
        return "fail:no-match"
    if _RE_FILE_NOT_READ.search(t):
        return "fail:file-not-read"
    if _RE_FILE_CHANGED.search(t):
        return "fail:file-changed"
    if _RE_PERM_DENIED.search(t):
        return "fail:perm"
    if _RE_GENERIC_REJECTED.search(first):
        return "fail:other"
    return "unknown"


_ANCHOR_BARE = re.compile(r"^[a-zA-Z]?[0-9]+[a-z]{2}$")


def _detect_edit_format(tool_name: str, args_obj: dict | None) -> str:
    if tool_name == "write":
        return "write"
    if tool_name == "ast_edit":
        return "ast_edit"
    if not isinstance(args_obj, dict):
        return "unknown"
    has = lambda k: k in args_obj  # noqa: E731
    if has("oldText") and has("newText"):
        return "oldText/newText"
    if has("old_text") and has("new_text"):
        return "old_text/new_text"
    if has("diff") and has("op"):
        return "diff+op"
    if has("diff") and has("operation"):
        return "diff+operation"
    if has("diff"):
        return "diff"
    if has("replace") or has("insert"):
        return "replace/insert"
    edits = args_obj.get("edits")
    if isinstance(edits, list) and edits and isinstance(edits[0], dict):
        first = edits[0]
        fh = lambda k: k in first  # noqa: E731
        if fh("loc") and (fh("splice") or fh("pre") or fh("post") or fh("sed")):
            return "loc+splice/pre/post/sed"
        if fh("loc") and fh("content"):
            return "loc+content"
        if fh("set_line"):
            return "set_line"
        if fh("insert_after"):
            return "insert_after"
        if fh("op") and fh("pos") and fh("end") and fh("lines"):
            return "op+pos+end+lines"
        if fh("op") and fh("pos") and fh("lines"):
            return "op+pos+lines"
        if fh("op") and fh("sel") and fh("content"):
            return "op+sel+content"
        if fh("all") and (fh("new_text") or fh("old_text")):
            return "per-edit:old_text/new_text"
        return "edits[" + ",".join(sorted(first.keys())) + "]"
    return ",".join(sorted(args_obj.keys()))


def _loc_shape(loc: str) -> str:
    if not loc:
        return "empty"
    if loc == "$":
        return "$file"
    if ":" in loc and not loc.startswith("$"):
        rest = loc.rsplit(":", 1)[1]
    else:
        rest = loc
    if rest.startswith("(") and rest.endswith(")"):
        return "bracket-(body)"
    if rest.startswith("[") and rest.endswith("]"):
        return "bracket-[block]"
    if rest.startswith("(") or rest.startswith("["):
        return "bracket-tail"
    if rest.endswith(")") or rest.endswith("]"):
        return "bracket-head"
    if _ANCHOR_BARE.match(rest):
        return "bare-anchor"
    return "other"


def _classify_edit_args(tool_name: str, args_obj: dict | None) -> tuple[str, list[str], list[str]]:
    """Returns (format, verbs, loc_shapes)."""
    fmt = _detect_edit_format(tool_name, args_obj)
    verbs: list[str] = []
    loc_shapes: list[str] = []
    if tool_name == "write":
        verbs.append("write")
    elif tool_name == "edit" and isinstance(args_obj, dict):
        edits = args_obj.get("edits")
        if isinstance(edits, list):
            for op in edits:
                if not isinstance(op, dict):
                    continue
                loc_val = op.get("loc")
                loc_shapes.append(_loc_shape(loc_val if isinstance(loc_val, str) else ""))
                v: list[str] = []
                if op.get("splice"):
                    v.append("splice")
                if op.get("pre"):
                    v.append("pre")
                if op.get("post"):
                    v.append("post")
                if op.get("sed"):
                    v.append("sed")
                if not v:
                    v.append("none")
                verbs.append("+".join(v))
    return fmt, verbs, loc_shapes


def cmd_edits(args: argparse.Namespace) -> int:
    conn = open_ro()
    where_session, where_args = _session_filter_clause(conn, args)
    sf_clause = "AND c.session_file IN (" + ",".join("?" * len(where_args)) + ")" if where_args else ""

    rows = conn.execute(
        f"""
        SELECT
          c.session_file, c.call_id, c.tool_name, c.arg_json, c.timestamp,
          r.result_text, r.is_error
        FROM ss_tool_calls c
        LEFT JOIN ss_tool_results r
          ON r.session_file = c.session_file AND r.call_id = c.call_id
        WHERE c.tool_name IN ('edit','ast_edit','write') {sf_clause}
        ORDER BY c.timestamp
        """,
        where_args,
    ).fetchall()

    if not rows:
        print("no edit-family tool calls found")
        return 0

    by_tool: Counter = Counter()
    by_format: Counter = Counter()
    status_by_tool: dict[str, Counter] = defaultdict(Counter)
    status_by_format: dict[str, Counter] = defaultdict(Counter)
    verb_count: Counter = Counter()
    loc_count: Counter = Counter()
    fails_by_verb: dict[str, Counter] = defaultdict(Counter)
    fails_by_loc: dict[str, Counter] = defaultdict(Counter)
    sessions = set()
    failed_samples: list[tuple[str, str, list[str], list[str], str]] = []

    for r in rows:
        sessions.add(r["session_file"])
        tool = r["tool_name"]
        try:
            args_obj = json.loads(r["arg_json"]) if r["arg_json"] else None
        except Exception:
            args_obj = None
        fmt, verbs, locs = _classify_edit_args(tool, args_obj)
        status = classify_edit_result(r["result_text"] or "")

        by_tool[tool] += 1
        by_format[fmt] += 1
        status_by_tool[tool][status] += 1
        status_by_format[fmt][status] += 1
        for v in verbs:
            verb_count[v] += 1
            fails_by_verb[v][status] += 1
        for l in locs:
            loc_count[l] += 1
            fails_by_loc[l][status] += 1

        if status.startswith("fail") and len(failed_samples) < 8:
            text = r["result_text"] or ""
            first = text.split("\n\n", 1)[0]
            failed_samples.append((tool, status, verbs, locs, truncate_line(first, 220)))

    print("# Edit-tool usage")
    print(f"\nTotal tool calls: {len(rows)} (across {len(sessions)} sessions)")

    _print_counter("\n## By tool", by_tool)
    print("\n## Outcome by tool")
    for tool in sorted(by_tool):
        print(f"\n  {tool} ({by_tool[tool]} calls):")
        for st, n in sorted(status_by_tool[tool].items(), key=lambda kv: -kv[1]):
            print(f"    {st:<28} {n}")

    _print_counter("\n## edit verb distribution (per sub-edit)", verb_count)
    _print_counter("\n## edit locator shape distribution", loc_count)

    print("\n## Failure rate per verb shape")
    for v, _ in verb_count.most_common():
        total, failed = _fail_totals(fails_by_verb[v])
        print(f"  {v:<20} {failed}/{total} failed ({pct(failed, total):.0f}%)")

    print("\n## Failure rate per locator shape")
    for l, _ in loc_count.most_common():
        total, failed = _fail_totals(fails_by_loc[l])
        print(f"  {l:<20} {failed}/{total} failed ({pct(failed, total):.0f}%)")

    _print_counter("\n## edit-tool argument-format usage", by_format)

    print("\n## Failure rate per argument format")
    for f, _ in by_format.most_common():
        total, failed = _fail_totals(status_by_format[f])
        print(f"  {f:<32} {failed:>6}/{total:<6} failed ({pct(failed, total):.0f}%)")

    print("\n## Failure breakdown per top format")
    for f, _ in by_format.most_common(8):
        print(f"\n  {f} ({by_format[f]} total)")
        for st, n in sorted(status_by_format[f].items(), key=lambda kv: -kv[1]):
            print(f"    {st:<28} {n}")

    print("\n## Sample failed edits")
    for tool, status, verbs, locs, snippet in failed_samples:
        print(f"\n— {tool} [{status}] verbs={verbs} loc={locs}\n  result: {snippet}")

    return 0


def _print_counter(header: str, c: Counter) -> None:
    print(header)
    for k, v in c.most_common():
        print(f"  {k:<32} {v}")


def _fail_totals(c: Counter) -> tuple[int, int]:
    total = sum(c.values())
    failed = sum(v for k, v in c.items() if k.startswith("fail"))
    return total, failed


# --------------------------------------------------------------------------- #
# Entry point

def main() -> int:
    ap = argparse.ArgumentParser(description="session-stats analyses (sqlite-backed)")
    sub = ap.add_subparsers(dest="cmd", required=True)

    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("-n", "--limit", type=int, default=0,
                        help="restrict to N most-recent sessions (0 = all)")
    common.add_argument("--folder", default=None,
                        help="filter sessions whose folder contains this substring")

    ap_tools = sub.add_parser("tools", parents=[common], help="per-tool token totals")
    ap_tools.add_argument("--by", default=None,
                          help="bucket per-call data: h, d, w, m, or <N>{h,d,w}")
    ap_tools.add_argument("--top", type=int, default=10, help="top tools per bucket")
    ap_tools.add_argument("--tool", default=None, help="restrict bucket view to one tool")
    ap_tools.set_defaults(func=cmd_tools)

    ap_edits = sub.add_parser("edits", parents=[common], help="edit reliability audit")
    ap_edits.set_defaults(func=cmd_edits)

    args = ap.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
