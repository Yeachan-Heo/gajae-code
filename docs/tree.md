# `/tree` Command Reference

`/tree` opens the interactive **Session Tree** navigator. It lets you jump to any entry in the current session file and continue from that point.

This is an in-file leaf move, not a new session export.

## What `/tree` does

- Builds a tree from current session entries (`SessionManager.getTree()`)
- Opens `TreeSelectorComponent` with keyboard navigation, filters, and search
- On selection, calls `AgentSession.navigateTree(targetId, { summarize, customInstructions })`
- Rebuilds visible chat from the new leaf path
- Optionally prefills editor text when selecting a user/custom message

Primary implementation:

- `src/modes/controllers/input-controller.ts` (`/tree`, keybinding wiring, double-escape behavior)
- `src/modes/controllers/selector-controller.ts` (tree UI launch + summary prompt flow)
- `src/modes/components/tree-selector.ts` (navigation, filters, search, labels, rendering)
- `src/session/agent-session.ts` (`navigateTree` leaf switching + optional summary)
- `src/session/session-manager.ts` (`getTree`, `branch`, `branchWithSummary`, `resetLeaf`, label persistence)

## How to open it

The following open the tree selector:

- `/tree`
- configured keybinding action `tree`
- double-escape on an empty editor when `doubleEscapeAction = "tree"` (default)

With `doubleEscapeAction = "branch"`, double Escape opens the user-message branch picker instead; the `app.session.fork` action opens that picker directly.

## Tree UI model

The tree is rendered from session entry parent pointers (`id` / `parentId`).

- Children are sorted by timestamp ascending (older first, newer lower)
- Active branch (path from root to current leaf) is marked with a bullet
- Labels (if present) render as `[label]` before node text
- If multiple roots exist (orphaned/broken parent chains), they are shown under a virtual branching root

```text
Example tree view (active path marked with •):

├─ user: "Start task"
│  └─ assistant: "Plan"
│     ├─ • user: "Try approach A"
│     │  └─ • assistant: "A result"
│     │     └─ • [milestone] user: "Continue A"
│     └─ user: "Try approach B"
│        └─ assistant: "B result"
```

The selector recenters around current selection and shows up to:

- `max(5, floor(terminalHeight / 2))` rows

## Keybindings inside tree selector

- `Up` / `Down`: move selection (wraps)
- `Left` / `Right`: page up / page down
- `Enter`: select node
- `Esc`: clear search if active; otherwise close selector
- `Ctrl+C`: close selector
- `Type`: append to search query
- `Backspace`: delete search character
- `Shift+L`: edit/clear label on selected entry
- `Ctrl+O`: cycle filter forward
- `Shift+Ctrl+O`: cycle filter backward
- `Alt+D/T/U/L/A`: jump directly to specific filter mode

## Filters and search semantics

Filter modes (`TreeList`):

1. `default`
2. `no-tools`
3. `user-only`
4. `labeled-only`
5. `all`

### `default`

Shows most conversational nodes, but hides bookkeeping entry types:

- `label`
- `custom`
- `model_change`
- `thinking_level_change`

### `no-tools`

Same as `default`, plus hides `toolResult` messages.

### `user-only`

Only `message` entries where role is `user`.

### `labeled-only`

Only entries that currently resolve to a label.

### `all`

Everything in the session tree, including bookkeeping/custom entries.

### Tool-only assistant node behavior

Assistant messages that contain **only tool calls** (no text) are hidden by default in all filtered views unless:

- message is error/aborted (`stopReason` not `stop`/`toolUse`), or
- it is the current leaf (always kept visible)

### Search behavior

- Query is tokenized by spaces
- Matching is case-insensitive
- All tokens must match (AND semantics)
- Searchable text includes label, role, and type-specific content (message text, branch summary text, custom type, tool command snippets, etc.)

## Selection outcomes (important)

`navigateTree` computes new leaf behavior from selected entry type:

### Selecting `user` message

- New leaf becomes selected entry’s `parentId`
- If parent is `null` (root user message), leaf resets to root (`resetLeaf()`)
- Selected message text is copied to editor for editing/resubmit

### Selecting `custom_message`

- Same leaf rule as user messages (`parentId`)
- Text content is extracted and copied to editor

### Selecting non-user node (assistant/tool/summary/compaction/custom bookkeeping/etc.)

- New leaf becomes selected node id
- Editor is not prefilled

### Selecting current leaf

- No-op; selector closes with “Already at this point”

```text
Selection decision (simplified):

selected node
   │
   ├─ is current leaf? ── yes ──> close selector (no-op)
   │
   ├─ is user/custom_message? ── yes ──> leaf := parentId (or resetLeaf for root)
   │                                     + prefill editor text
   │
   └─ otherwise ──> leaf := selected node id
                    + no editor prefill
```

## Summary-on-switch flow

Summary prompt is controlled by `branchSummary.enabled` (default: `false`).

When enabled, after picking a node the UI asks:

- `No summary`
- `Summarize`
- `Summarize with custom prompt`

Flow details:

- Escape in summary prompt reopens tree selector
- Custom prompt cancellation returns to summary choice loop
- During summarization, UI shows loader and binds `Esc` to `abortBranchSummary()`
- If summarization aborts, tree selector reopens and no move is applied

`navigateTree` internals:

- Collects abandoned-branch entries from old leaf to common ancestor
- Emits `session_before_tree` (extensions can cancel or inject summary)
- Uses default summarizer only if requested and needed
- Applies move with:
  - `branchWithSummary(...)` when summary exists
  - `branch(newLeafId)` for non-root move without summary
  - `resetLeaf()` for root move without summary
- Replaces agent conversation with rebuilt session context
- Emits `session_tree`

Note: if user requests summary but there is nothing to summarize, navigation proceeds without creating a summary entry.

## Labels

Label edits in tree UI call `appendLabelChange(targetId, label)`.

- non-empty label sets/updates resolved label
- empty label clears it
- labels are stored as append-only `label` entries
- tree nodes display resolved label state, not raw label-entry history

## `/tree` vs adjacent operations

| Operation | Scope                                          | Result                                                                                                                                                     |
| --------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/tree`   | Current session file                           | Moves leaf to selected point (same file)                                                                                                                   |
| `app.session.fork` action or branch-configured double Escape | Current branching lifecycle | Opens the existing user-message branch picker; behavior is unchanged                                                                                       |
| `/fork`   | Selected user prompt; new persistent session file | Opens the same picker, copies history before the selected prompt into an independent session, switches to it, and prefills the prompt without submitting |
| `/resume` | Session list                                   | Switches to another session file                                                                                                                           |

Key distinction: `/tree` is a navigation/repositioning tool inside one session file. Interactive `/fork` adds the persistent slash-command path without changing the existing `app.session.fork` action, branch-configured double Escape, or `/resume`.

## Operator workflows

### Re-run from an earlier user prompt without losing current branch

1. `/tree`
2. search/select earlier user message
3. choose `No summary` (or summarize if needed)
4. edit prefilled text in editor
5. submit

Effect: new branch grows from selected point within same session file.

### Leave current branch with context breadcrumb

1. enable `branchSummary.enabled`
2. `/tree` and select target node
3. choose `Summarize` (or custom prompt)

Effect: a `branch_summary` entry is appended at the target position before continuing.

### Investigate hidden bookkeeping entries

1. `/tree`
2. press `Alt+A` (all)
3. search for `model`, `thinking`, `custom`, or labels

Effect: inspect full internal timeline, not just conversational nodes.

### Bookmark pivot points for later jumps

1. `/tree`
2. move to entry
3. `Shift+L` and set label
4. later use `Alt+L` (`labeled-only`) to jump quickly

Effect: fast navigation among durable branch landmarks.
