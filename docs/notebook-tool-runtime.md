# Notebook runtime internals

This document describes how coding-agent reads and edits Jupyter notebooks (`.ipynb`) and how that relates to Python execution.

The critical distinction: **there is no dedicated `notebook` tool, and nothing executes notebook cells**. `read` and `edit` convert a notebook to an editable plain-text cell representation and write edits back to the notebook JSON. Running Python goes through the `eval` tool (`language: "py"`) or the `python` tool, neither of which reads or writes `.ipynb` files.

## Implementation files

- [`src/edit/notebook.ts`](../packages/coding-agent/src/edit/notebook.ts) — notebook JSON ↔ editable text conversion
- [`src/edit/read-file.ts`](../packages/coding-agent/src/edit/read-file.ts) — edit-mode read/serialize hooks that route `.ipynb` through the converter
- [`src/tools/read.ts`](../packages/coding-agent/src/tools/read.ts) — `read` tool notebook branch
- [`src/tools/eval.ts`](../packages/coding-agent/src/tools/eval.ts), [`src/tools/python.ts`](../packages/coding-agent/src/tools/python.ts) — Python execution surfaces (see [`python-repl.md`](python-repl.md))

## 1) Editable cell representation

`notebookToEditableText()` renders each cell as a marker line followed by the cell source, and joins cells with `\n`:

```text
# %% [markdown] cell:0
# Title
# %% [code] cell:1
import pandas as pd
df = pd.read_csv("data.csv")
# %% [raw] cell:2
```

- Marker format: `# %% [<cell_type>] cell:<index>`, where `<cell_type>` is `code`, `markdown`, or `raw` and `<index>` is the cell's position in the original notebook.
- A cell with empty source renders as the marker line alone.
- Only cell sources are shown. Outputs, execution counts, and cell/notebook metadata are not part of the text, but they are preserved on write (see [Round-trip semantics](#3-round-trip-semantics)).
- A cell source that ends with a newline shows as a blank line before the next marker and round-trips with that newline intact.

## 2) Tool integration

### `read`

- A `.ipynb` path is converted with `readEditableNotebookText()` unless the `:raw` selector is used. `:raw` returns the notebook JSON verbatim.
- Line selectors and multi-range selectors apply to the converted text, not the JSON. Results are labelled as `notebook` content.
- See [`tools/read.md`](tools/read.md#jupyter-notebooks) for truncation defaults.

### `edit`

The `replace`, `patch`, and `hashline` edit modes (and `apply_patch`, which expands into patch-mode entries) load files through `readEditFileText()` and write through `serializeEditFileText()`:

- `readEditFileText()` enforces the `MAX_EDIT_FILE_BYTES` (8 MiB) guard **before** notebook conversion, so an oversized notebook fails fast instead of being parsed on the main thread.
- For `.ipynb`, the edit mode then operates on the editable text, and `serializeEditFileText()` maps the edited text back to notebook JSON via `serializeEditedNotebookText()`.
- If the notebook does not exist at serialization time (an edit mode creating a new file), edits apply to a new empty notebook (`nbformat` 4, `nbformat_minor` 5).
- Notebook JSON is written with `JSON.stringify(notebook, null, 1)`.

The `vim` edit mode reads and writes the file's raw bytes, so on a `.ipynb` it edits the notebook JSON directly.

### `write`

`write` does not use the notebook converter. Content passed to `write` for a `.ipynb` path is written verbatim, so it must already be notebook JSON.

## 3) Round-trip semantics

`applyNotebookEditableText()` parses the edited text into cells and rebuilds the `cells` array from a deep clone of the original notebook, so notebook-level `metadata`, `nbformat`, and any other top-level keys are preserved.

For each parsed cell, in order:

- **Marker with `cell:N` that refers to an unused original cell**: that original cell is cloned, keeping its metadata, outputs, and any other keys. Its `cell_type` is set from the marker and its `source` is replaced.
  - If the result is a `code` cell, missing `execution_count` / `outputs` are initialized to `null` / `[]`; existing values are kept.
  - If the result is a non-code cell, `execution_count` and `outputs` are removed.
- **Marker without `cell:N`, with an out-of-range index, or with an index already used earlier in the text**: a new cell is created with `metadata: {}`; new code cells also get `execution_count: null` and `outputs: []`.
- Original cells whose markers are removed from the text are dropped.

Consequences:

- Deleting a cell = deleting its marker and source.
- Inserting a cell = adding a marker without an index (for example `# %% [code]`).
- Moving a cell = moving its marker block; keeping the original `cell:N` preserves its outputs and metadata.
- Duplicating a marker's index gives the first occurrence the original cell and makes later occurrences new cells.

Cell source is stored as a line array with trailing newlines preserved (`splitNotebookSource()`): every line except the last keeps its `\n`, and the last line has no forced trailing newline.

## 4) Error surfaces

Conversion throws for:

- missing file on read: `File not found: <path>` (serialization of a newly created notebook starts from an empty notebook instead)
- invalid JSON: `Invalid JSON in notebook: <path>`
- non-object root or missing `cells` array: `Invalid notebook structure (...)`
- a cell that is not an object or has a `cell_type` other than `code` / `markdown` / `raw`: `Invalid notebook cell <index> in <path>`
- edited text whose first line is not a cell marker: `Invalid notebook editable representation for <path>: ...`

## 5) Relationship to Python execution

Notebook handling and Python execution share no code path:

- `read`/`edit` never start a kernel, never execute cells, and never update cell `outputs` or `execution_count`.
- `eval` (`language: "py"`) and `python` run code in a subprocess-backed Python runner (`src/eval/py/`). Kernel lifecycle, session reuse, cancellation, display capture, and output truncation are documented in [`python-repl.md`](python-repl.md).

To run code from a notebook, read the relevant cells and pass their source to `eval` or `python` explicitly. No current tool both mutates an `.ipynb` file and executes its cells in a kernel.
