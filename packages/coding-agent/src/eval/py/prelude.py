from __future__ import annotations
# GJC prelude helpers (loaded once into the runner namespace)
if "__gjc_prelude_loaded__" not in globals():
    __gjc_prelude_loaded__ = True
    from pathlib import Path
    import os, json

    # __gjc_display is injected by runner.py before the prelude executes; it
    # mirrors IPython's display() semantics with the same MIME bundle output.
    _gjc_display = __gjc_display  # type: ignore[name-defined]

    _PRESENTABLE_REPRS = (
        "_repr_mimebundle_",
        "_repr_html_",
        "_repr_json_",
        "_repr_markdown_",
        "_repr_png_",
        "_repr_jpeg_",
        "_repr_svg_",
        "_repr_latex_",
    )

    def display(value):
        """Render a value. Falls back to a JSON+text/plain bundle for plain dict/list/tuple."""
        if any(hasattr(value, attr) for attr in _PRESENTABLE_REPRS):
            _gjc_display(value)
            return
        if isinstance(value, (dict, list, tuple)):
            try:
                bundle = {"application/json": value, "text/plain": repr(value)}
                _gjc_display(bundle, raw=True)
                return
            except Exception:
                pass
        _gjc_display(value)

    def _emit_status(op: str, **data):
        """Emit structured status event for TUI rendering."""
        _gjc_display({"application/x-gjc-status": {"op": op, **data}}, raw=True)


    def env(key: str | None = None, value: str | None = None):
        """Get/set environment variables."""
        if key is None:
            items = dict(sorted(os.environ.items()))
            _emit_status("env", count=len(items), keys=list(items.keys())[:20])
            return items
        if value is not None:
            os.environ[key] = value
            _emit_status("env", key=key, value=value, action="set")
            return value
        val = os.environ.get(key)
        _emit_status("env", key=key, value=val, action="get")
        return val

    def read(path: str | Path, *, offset: int = 1, limit: int | None = None) -> str:
        """Read file contents. offset/limit are 1-indexed line numbers."""
        p = Path(path)
        data = p.read_text(encoding="utf-8")
        lines = data.splitlines(keepends=True)
        if offset > 1 or limit is not None:
            start = max(0, offset - 1)
            end = start + limit if limit else len(lines)
            lines = lines[start:end]
            data = "".join(lines)
        preview = data[:500]
        _emit_status("read", path=str(p), chars=len(data), preview=preview)
        return data

    def write(path: str | Path, content: str) -> Path:
        """Write file contents (create parents)."""
        p = Path(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content, encoding="utf-8")
        _emit_status("write", path=str(p), chars=len(content))
        return p

    def append(path: str | Path, content: str) -> Path:
        """Append to file."""
        p = Path(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        with p.open("a", encoding="utf-8") as f:
            f.write(content)
        _emit_status("append", path=str(p), chars=len(content))
        return p

    def sort(text: str, *, reverse: bool = False, unique: bool = False) -> str:
        """Sort lines of text."""
        lines = text.splitlines()
        if unique:
            lines = list(dict.fromkeys(lines))
        lines = sorted(lines, reverse=reverse)
        out = "\n".join(lines)
        _emit_status("sort", lines=len(lines), unique=unique, reverse=reverse)
        return out

    def uniq(text: str, *, count: bool = False) -> str | list[tuple[int, str]]:
        """Remove duplicate adjacent lines (like uniq)."""
        lines = text.splitlines()
        if not lines:
            _emit_status("uniq", groups=0)
            return [] if count else ""
        groups: list[tuple[int, str]] = []
        current = lines[0]
        current_count = 1
        for line in lines[1:]:
            if line == current:
                current_count += 1
                continue
            groups.append((current_count, current))
            current = line
            current_count = 1
        groups.append((current_count, current))
        _emit_status("uniq", groups=len(groups), count_mode=count)
        if count:
            return groups
        return "\n".join(line for _, line in groups)

    def counter(
        items: str | list,
        *,
        limit: int | None = None,
        reverse: bool = True,
    ) -> list[tuple[int, str]]:
        """Count occurrences and sort by frequency. Like sort | uniq -c | sort -rn.
        
        items: text (splits into lines) or list of strings
        reverse: True for descending (most common first), False for ascending
        Returns: [(count, item), ...] sorted by count
        """
        from collections import Counter
        if isinstance(items, str):
            items = items.splitlines()
        counts = Counter(items)
        sorted_items = sorted(counts.items(), key=lambda x: (x[1], x[0]), reverse=reverse)
        if limit is not None:
            sorted_items = sorted_items[:limit]
        result = [(count, item) for item, count in sorted_items]
        _emit_status("counter", unique=len(counts), total=sum(counts.values()), top=result[:10])
        return result
    def tree(path: str | Path = ".", *, max_depth: int = 3, show_hidden: bool = False) -> str:
        """Return directory tree."""
        base = Path(path)
        lines = []
        def walk(p: Path, prefix: str, depth: int):
            if depth > max_depth:
                return
            items = sorted(p.iterdir(), key=lambda x: (not x.is_dir(), x.name.lower()))
            items = [i for i in items if show_hidden or not i.name.startswith(".")]
            for i, item in enumerate(items):
                is_last = i == len(items) - 1
                connector = "└── " if is_last else "├── "
                suffix = "/" if item.is_dir() else ""
                lines.append(f"{prefix}{connector}{item.name}{suffix}")
                if item.is_dir():
                    ext = "    " if is_last else "│   "
                    walk(item, prefix + ext, depth + 1)
        lines.append(str(base) + "/")
        walk(base, "", 1)
        out = "\n".join(lines)
        _emit_status("tree", path=str(base), entries=len(lines) - 1, preview=out[:1000])
        return out

    def diff(a: str | Path, b: str | Path) -> str:
        """Compare two files, return unified diff."""
        import difflib
        path_a, path_b = Path(a), Path(b)
        lines_a = path_a.read_text(encoding="utf-8").splitlines(keepends=True)
        lines_b = path_b.read_text(encoding="utf-8").splitlines(keepends=True)
        result = difflib.unified_diff(lines_a, lines_b, fromfile=str(path_a), tofile=str(path_b))
        out = "".join(result)
        _emit_status("diff", file_a=str(path_a), file_b=str(path_b), identical=not out, preview=out[:500])
        return out

    def output(
        *ids: str,
        format: str = "raw",
        query: str | None = None,
        offset: int | None = None,
        limit: int | None = None,
    ) -> str | dict | list[dict]:
        """Read task/agent output by ID. Returns text or JSON depending on format.
        
        Args:
            *ids: Output IDs to read (e.g., 'explore_0', 'reviewer_1')
            format: 'raw' (default), 'json' (dict with metadata), 'stripped' (no ANSI)
            query: jq-like query for JSON outputs (e.g., '.endpoints[0].file')
            offset: Line number to start reading from (1-indexed)
            limit: Maximum number of lines to read
        
        Returns:
            Single ID: str (format='raw'/'stripped') or dict (format='json')
            Multiple IDs: list of dict with 'id' and 'content'/'data' keys
        
        Examples:
            output('explore_0')  # Read as raw text
            output('reviewer_0', format='json')  # Read with metadata
            output('explore_0', query='.files[0]')  # Extract JSON field
            output('explore_0', offset=10, limit=20)  # Lines 10-29
            output('explore_0', 'reviewer_1')  # Read multiple outputs
        """
        if not ids:
            _emit_status("output", error="No IDs provided")
            raise ValueError("At least one output ID is required")
        
        if query and (offset is not None or limit is not None):
            _emit_status("output", error="query cannot be combined with offset/limit")
            raise ValueError("query cannot be combined with offset/limit")
        
        # Check if tool bridge is available
        if 'tool' not in globals():
            _emit_status("output", error="Tool bridge not available")
            raise RuntimeError("output() requires tool bridge (PI_TOOL_BRIDGE_* env vars) to be available")
        
        results: list[dict] = []
        
        for output_id in ids:
            # Read the whole resource via tool bridge with :raw to avoid truncation at 768 cols
            # and line-number decoration. This ensures output() returns exact artifact bytes.
            path = f"agent://{output_id}:raw"
            try:
                # Call tool.read() to get the content
                # The read tool returns either a string or {text, details, ...}
                result = tool.read({"path": path})
                if isinstance(result, dict):
                    # ReadTool returns {text, details, ...} when details are set
                    content = result.get("text", "")
                else:
                    # Fallback: treat as string directly
                    content = result
            except Exception as e:
                _emit_status("output", id=output_id, error=str(e))
                raise
            
            # Convert to string if not already
            if not isinstance(content, str):
                content = str(content)
            
            # Handle offset/limit by slicing in Python (exact ranges, no context expansion)
            raw_content = content
            if offset is not None or limit is not None:
                lines = content.splitlines()
                start_line = max(0, (offset or 1) - 1)  # Convert to 0-indexed
                if start_line >= len(lines):
                    _emit_status("output", id=output_id, error=f"Offset {offset or 1} beyond end ({len(lines)} lines)")
                    raise ValueError(f"Offset {offset or 1} is beyond end of output ({len(lines)} lines) for {output_id}")
                effective_limit = limit if limit is not None else len(lines) - start_line
                end_line = min(len(lines), start_line + effective_limit)
                content = "\n".join(lines[start_line:end_line])
            
            # Handle query
            if query:
                try:
                    json_value = json.loads(content)
                except json.JSONDecodeError as e:
                    _emit_status("output", id=output_id, error=f"Not valid JSON: {e}")
                    raise ValueError(f"Output {output_id} is not valid JSON: {e}")
                
                # Apply jq-like query
                result_value = _apply_query(json_value, query)
                try:
                    selected_content = json.dumps(result_value, indent=2) if result_value is not None else "null"
                except (TypeError, ValueError):
                    selected_content = str(result_value)
            else:
                selected_content = content
            
            # Strip ANSI codes if requested
            if format == "stripped":
                import re
                selected_content = re.sub(r"\x1b\[[0-9;]*m", "", selected_content)
            
            # Build result
            if format == "json":
                result_data = {
                    "id": output_id,
                    "path": f"agent://{output_id}",
                    "line_count": len(raw_content.splitlines()),
                    "char_count": len(raw_content) if not query else len(selected_content),
                    "content": selected_content,
                }
                if query:
                    result_data["query"] = query
                results.append(result_data)
            else:
                results.append({"id": output_id, "content": selected_content})
        
        # Return format
        if len(ids) == 1:
            if format == "json":
                _emit_status("output", id=ids[0], chars=results[0]["char_count"])
                return results[0]
            _emit_status("output", id=ids[0], chars=len(results[0]["content"]))
            return results[0]["content"]
        
        # Multiple IDs
        if format == "json":
            total_chars = sum(r["char_count"] for r in results)
            _emit_status("output", count=len(results), total_chars=total_chars)
            return results
        
        combined_output: list[dict] = []
        for r in results:
            combined_output.append({"id": r["id"], "content": r["content"]})
        total_chars = sum(len(r["content"]) for r in combined_output)
        _emit_status("output", count=len(combined_output), total_chars=total_chars)
        return combined_output

    def _apply_query(data: any, query: str) -> any:
        """Apply jq-like query to data. Supports .key, [index], and chaining."""
        if not query:
            return data
        
        query = query.strip()
        if query.startswith("."):
            query = query[1:]
        if not query:
            return data
        
        # Parse query into tokens
        tokens = []
        current_token = ""
        i = 0
        while i < len(query):
            ch = query[i]
            if ch == ".":
                if current_token:
                    tokens.append(("key", current_token))
                    current_token = ""
            elif ch == "[":
                if current_token:
                    tokens.append(("key", current_token))
                    current_token = ""
                # Find matching ]
                j = i + 1
                while j < len(query) and query[j] != "]":
                    j += 1
                bracket_content = query[i+1:j]
                if bracket_content.startswith('"') and bracket_content.endswith('"'):
                    tokens.append(("key", bracket_content[1:-1]))
                else:
                    tokens.append(("index", int(bracket_content)))
                i = j
            else:
                current_token += ch
            i += 1
        if current_token:
            tokens.append(("key", current_token))
        
        # Apply tokens
        current = data
        for token_type, value in tokens:
            if token_type == "index":
                if not isinstance(current, list) or value >= len(current):
                    return None
                current = current[value]
            elif token_type == "key":
                if not isinstance(current, dict) or value not in current:
                    return None
                current = current[value]
        
        return current


    class _ToolCallable:
        """Invokes one host-side tool via the loopback HTTP bridge."""

        __slots__ = ("_proxy", "_name")

        def __init__(self, proxy: "_ToolProxy", name: str):
            self._proxy = proxy
            self._name = name

        def __repr__(self) -> str:
            return f"<tool.{self._name}>"

        def __call__(self, args=None, /, **kwargs):
            import urllib.request, urllib.error
            if args is None:
                merged: dict = {}
            elif isinstance(args, dict):
                merged = dict(args)
            else:
                raise TypeError(
                    f"tool.{self._name}(...) expects a dict of arguments (got {type(args).__name__})"
                )
            merged.update(kwargs)
            if "_i" not in merged:
                merged["_i"] = "py prelude"
            payload = json.dumps(
                {"session": self._proxy._session, "name": self._name, "args": merged}
            ).encode("utf-8")
            req = urllib.request.Request(
                f"{self._proxy._base}/v1/tool",
                data=payload,
                method="POST",
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {self._proxy._token}",
                },
            )
            try:
                with urllib.request.urlopen(req) as resp:
                    body = resp.read()
            except urllib.error.HTTPError as exc:
                body = exc.read()
            try:
                data = json.loads(body)
            except json.JSONDecodeError:
                raise RuntimeError(
                    f"tool.{self._name}: bridge returned non-JSON response: {body[:200]!r}"
                ) from None
            if not isinstance(data, dict) or not data.get("ok"):
                msg = (data or {}).get("error") if isinstance(data, dict) else None
                raise RuntimeError(msg or f"tool.{self._name} failed")
            return data.get("value")

    class _ToolProxy:
        """`tool.<name>(args)` proxy mirroring the JS session tool API."""

        __slots__ = ("_base", "_token", "_session")

        def __init__(self, base: str, token: str, session: str):
            self._base = base.rstrip("/")
            self._token = token
            self._session = session

        def __getattr__(self, name: str) -> _ToolCallable:
            if name.startswith("_"):
                raise AttributeError(name)
            return _ToolCallable(self, name)

        def __getitem__(self, name: str) -> _ToolCallable:
            return _ToolCallable(self, name)

        def __repr__(self) -> str:
            return f"<tool proxy session={self._session}>"

    if all(
        _k in os.environ
        for _k in ("PI_TOOL_BRIDGE_URL", "PI_TOOL_BRIDGE_CAPABILITY", "PI_TOOL_BRIDGE_SESSION")
    ):
        tool = _ToolProxy(
            os.environ["PI_TOOL_BRIDGE_URL"],
            os.environ["PI_TOOL_BRIDGE_CAPABILITY"],
            os.environ["PI_TOOL_BRIDGE_SESSION"],
        )
