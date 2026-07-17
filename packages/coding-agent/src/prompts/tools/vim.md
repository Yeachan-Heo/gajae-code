Vim-style `edit` mode. The tool name stays `edit`; every call requires `file`, and the buffer loads automatically on first use.
- `{"file": "path"}` - view file
- `{"file": "path", "steps": [{"kbd": ["…"], "insert": "…"}]}` - edit file
- `pause` (optional boolean) - a "paused" call skips the auto-save after its steps and may leave the last step in INSERT mode; the buffer stays open for the next call. Non-paused calls auto-save once after all steps complete.

**Multi-location edits: always edit highest line number first (bottom-up).** Each insert shifts lines below it.

## steps vs kbd vs insert

`steps` = ordered editing steps. Each step runs `kbd`, then optionally types `insert`.
`kbd` = Vim commands only (`dd`, `G`, `o`, `cc`, `gg`, etc.).
`insert` = raw text content to type into the buffer.
`o`/`O` already create a new line — do not start `insert` with `\n`. A trailing `\n` in `insert` adds an extra blank line.

Never put text content in `kbd`. Only Vim keystrokes go there.
- BAD: `{"steps": [{"kbd": ["1Gohello world<Esc>"]}]}`
- BAD: `{"steps": [{"kbd": ["1Go", "hello world"]}]}`
- BAD: `{"steps": [{"kbd": ["1Ao"], "insert": "text"}]}`
- GOOD: `{"steps": [{"kbd": ["1Go"], "insert": "hello world"}]}`

If a step uses `insert`, the last `kbd` entry in that step must leave INSERT mode active (`o`, `O`, `i`, `a`, `A`, `cc`, `C`, `s`, `S`).

Each non-final `kbd` entry inside a step must end in NORMAL mode (add `<Esc>`).

Between steps, the tool auto-exits INSERT mode.

Whitespace in `kbd` is literal. Do not use spaces as separators between keys; `ggdGi` is one sequence, not `ggdG i`.

Common mistake: `Ni` means "insert N copies", NOT "insert at line N". To insert at line N, use `NGo` (below) or `NGO` (above).
## Editing patterns

`NGo` = new line BELOW line N. `NGO` = new line ABOVE line N.

Insert new line after line 3:
```json
{"file": "f.py", "steps": [{"kbd": ["3Go"], "insert": "    new line here"}]}
```

Insert new line before line 3:
```json
{"file": "f.py", "steps": [{"kbd": ["3GO"], "insert": "    new line here"}]}
```

Replace line N:
```json
{"file": "f.py", "steps": [{"kbd": ["5Gcc"], "insert": "    replacement content"}]}
```

Replace entire file. `ggdGi` = go to top, delete all, enter INSERT. Use that exact sequence when rewriting the whole file:
```json
{"file": "f.py", "steps": [{"kbd": ["ggdGi"], "insert": "entire new file content"}]}
```

Multi-location edit — edit **highest line number first** (bottom-up) so inserts don't shift later targets:
```json
{"file": "f.py", "steps": [
  {"kbd": ["8Go"], "insert": "    print(result)"},
  {"kbd": ["3Go"], "insert": "def helper(x):\n    return x + 1"}
]}
```
Each `o`/`O` insert adds lines, shifting everything below. Bottom-up order keeps all line numbers valid. Use `\n` within `insert` for multi-line content.

Navigation or search step without insert:
```json
{"file": "f.py", "steps": [{"kbd": ["/pattern<CR>"]}]}
```

Find and replace:
```json
{"file": "f.py", "steps": [{"kbd": [":%s/old/new/g<CR>"]}]}
```

Delete line range:
```json
{"file": "f.py", "steps": [{"kbd": [":3,5d<CR>"]}]}
```
Ex commands always start with `:` and end with `<CR>`. `3,5d` without `:` is NOT an ex command — it is interpreted as normal-mode keystrokes and will fail.

## Undo mistakes
- `{"file": "f.py", "steps": [{"kbd": ["u"]}]}` - undo last change
- `{"file": "f.py", "steps": [{"kbd": ["3u"]}]}` - undo last 3 changes

`:e!` reloads from disk. Warning: because non-paused calls auto-save, `:e!` reloads your last saved state, not the original file. Use `u` to undo instead. If stuck, use `ggdGi` with the full desired file content.

## Session persistence

The edit buffer in vim mode persists across tool calls. Cursor position, undo history, and file state are maintained until you close the buffer. Auto-save happens once after all steps in a non-paused call complete.

## Supported

Keys: `<Esc>` `<CR>` `<BS>` `<Tab>` `<C-d>` `<C-u>` `<C-r>` `<C-w>` `<C-o>`
Motions: `h j k l <Space> w b e 0 $ ^ + - _ gg G { } f F t T % H M L ; ,` with counts
Operators: `d c y p` with motions and text objects (`iw aw ip ap i" a" i( a( i{ a{`)
Insert: `i a o O I A cc C s S R` - these all enter INSERT mode; do not add another `i` after them
Visual: `v V` with `d y c > < ~ r u U p P o J`
Other: `.` repeat, `u`/`<C-r>` undo/redo, `/pattern<CR>` search, `n N * #`, `gv` `gJ` `gU` `gu` `ZZ` `ZQ`
Ex: `:w` `:q` `:wq` `:e` `:e!` `:N` `:s///` `:%s///` `:N,Md` `:%d` `:N,Mt N` `:sort` `:j` `:j!` `:g/pattern/d` `:v/pattern/d`
Addresses: absolute line numbers, `.`, `$`, and `+N`/`-N` relative offsets, including ranges like `:.,$d` and `:.+2,$g/pattern/d`
More ex: `:up` `:N,My` `:put` `:put!` `:N,Mco $` `:N,Mm $`
