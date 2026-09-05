# @gajae-code/tui

Minimal terminal UI framework with differential rendering and synchronized output for flicker-free interactive CLI applications.

## Features

- **Differential Rendering**: Three-strategy rendering system that only updates what changed
- **Synchronized Output**: Uses CSI 2026 for atomic screen updates (no flicker)
- **Bracketed Paste Mode**: Handles large pastes correctly with markers for >10 line pastes
- **Component-based**: Simple Component interface with render() method
- **Theme Support**: Components accept theme interfaces for customizable styling (the coding-agent bundles a red-claw crustacean theme built on these interfaces)
- **Built-in Components**: Text, TruncatedText, Input, Editor, Markdown, Loader, SelectList, SettingsList, Spacer, Image, Box, Container
- **Inline Images**: Renders images in terminals that support Kitty or iTerm2 graphics protocols
- **Autocomplete Support**: File paths and slash commands

## Quick Start

```typescript
import { TUI, Text, Editor, ProcessTerminal } from "@gajae-code/tui";

// Create terminal
const terminal = new ProcessTerminal();

// Create TUI
const tui = new TUI(terminal);

// Add components
tui.addChild(new Text("Welcome to my app!"));

const editor = new Editor(editorTheme);
editor.onSubmit = (text) => {
	console.log("Submitted:", text);
	tui.addChild(new Text(`You said: ${text}`));
};
tui.addChild(editor);

// Start
tui.start();
```

## Core API

### TUI

Main container that manages components and rendering.

#### Frame preparation

`tui.enqueueBeforeRender(callback: () => void): () => void` registers one synchronous,
one-shot preparation and returns an idempotent cancellation function. It requests a
normal full-mutation render on the existing 16 ms frame clock; it adds no timer and
does not force or expedite a frame. Normal, forced, and input-priority frames drain
the same snapshot before capturing render generations or reading layout, components,
viewport sources, or caches. Ordinary render requests made by preparation join that
frame without a request-only follow-up paint. Registrations made while draining run
in a later frame; their generations cannot commit before that preparation executes,
even when a newer ordinary request commits first or terminal output is queued.

Cancellation removes callback references, including entries already captured but
not yet invoked. Retained cancellation handles release their reference to the TUI
and callback on cancellation, invocation (including failure), or lifecycle
invalidation. Later cancellation calls are no-ops; an executing callback remains
live until its synchronous invocation returns. Preparation exceptions are logged, unrelated callbacks continue,
and the failed preparation's generation is not reported as successfully committed.
Throwing or lifecycle-invalidated preparations immediately resolve their existing
commit waiters `false`; late waiters for those generations also resolve `false`,
even after a newer successful frame. Retired generations are stored as merged,
sorted failure ranges, separate from live pending-frame exclusions. Contiguous
failures compact into one range; separated failures retain distinct ranges to
preserve exact outcomes. Historical failure ranges are not copied or scanned on
each frame (waiter lookup uses binary search).
History has no arbitrary expiry: its numeric storage is O(disjoint failed ranges),
not bounded over an indefinitely alternating failure/success session. Empty active
pending and hole sets do not imply bounded historical storage or prove leak freedom.
Callbacks must be synchronous (do not pass async functions).

The cancellation lifetime regression inspects Bun's heap snapshot for outgoing
local closure/entry paths to the owner, callback and payload, while all targets
remain deliberately rooted. Pending handles and an intentionally retaining arrow
are positive controls; retired handles must lose those paths. This checks reference
release without assuming when GC collects an object. It does not prove global leak
freedom or exclude unrelated module, runtime or test-runner roots.

`tui.setRenderPreparationLifecycleCallbacks(callbacks: { invalidate: () => void;
beforeStart: () => void } | undefined): void` installs a **single** preparation owner.
Replacing or clearing the owner invalidates its old queued and captured work and
calls its `invalidate` synchronously. Stop, terminal loss, and disposal do the same;
exceptions are logged without preventing cancellation. Disposal also clears the
owner. Enqueue while stopped, unavailable, invalidating, or disposed retains no work.
Disposal cancels pending render/width-settle timers and render requests; later normal,
forced, input-priority, and resize requests cannot rearm the disposed renderer.

After successful terminal setup, each `start()` calls `beforeStart` synchronously
before its first forced render request. The owner can enqueue fresh preparation
from its current authoritative state there, so restarting does not require another
provider event. Failed setup does not rearm work; a throwing `beforeStart` is logged
and its queued work is invalidated. Stop/start during a drain cannot revive that
drain's old snapshot. This API is only a presentation-preparation lifecycle seam,
not a general lifecycle event bus.

```typescript
const tui = new TUI(terminal);
tui.addChild(component);
tui.removeChild(component);
tui.start();
tui.stop();
tui.requestRender(); // Request a re-render

// Global debug key handler (Shift+Ctrl+D)
tui.onDebug = () => console.log("Debug triggered");
```

### Manual viewport and pinned suffix

`setBottomPinnedComponent(component)` marks a direct-child boundary. During manual viewport ownership, that child and all later direct children remain fixed at the bottom while rows before it form the scrollable lane; this does not require an output source. `scrollViewportPages()` moves by the lane height minus one; `scrollViewportBy()` supports smaller row steps and rejects non-finite deltas.

`setViewportOutputSource({ identity, revision })` reports semantic output changes without coupling the TUI to message types. A same-identity revision advance while manually scrolled displays the exact notice `New output — type to follow`; following live or changing/removing the identity clears it, while a stale same-identity revision rollback does not.

Pinned rows and the notice are excluded from transcript mouse-selection coordinates. When the terminal is too short, the focused direct-child suffix component is retained before decorative or lower-priority suffix rows.

### Component Interface

All components implement:

```typescript
interface Component {
	render(width: number): string[];
	handleInput?(data: string): void;
	invalidate?(): void;
}
```

| Method               | Description                                                                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `render(width)`      | Returns an array of strings, one per line. Each line **must not exceed `width`** or the TUI will error. Use `truncateToWidth()` or manual wrapping to ensure this. |
| `handleInput?(data)` | Called when the component has focus and receives keyboard input. The `data` string contains raw terminal input (may include ANSI escape sequences).                |
| `invalidate?()`      | Called to clear any cached render state. Components should re-render from scratch on the next `render()` call.                                                     |

## Built-in Components

### Container

Groups child components.

```typescript
const container = new Container();
container.addChild(component);
container.removeChild(component);
```

### Box

Container that applies padding and background color to all children.

```typescript
const box = new Box(
	1, // paddingX (default: 1)
	1, // paddingY (default: 1)
	(text) => chalk.bgGray(text), // optional background function
);
box.addChild(new Text("Content"));
box.setBgFn((text) => chalk.bgBlue(text)); // Change background dynamically
```

### Text

Displays multi-line text with word wrapping and padding.

```typescript
const text = new Text(
	"Hello World", // text content
	1, // paddingX (default: 1)
	1, // paddingY (default: 1)
	(text) => chalk.bgGray(text), // optional background function
);
text.setText("Updated text");
text.setCustomBgFn((text) => chalk.bgBlue(text));
```

### TruncatedText

Single-line text that truncates to fit viewport width. Useful for status lines and headers.

```typescript
const truncated = new TruncatedText(
	"This is a very long line that will be truncated...",
	0, // paddingX (default: 0)
	0, // paddingY (default: 0)
);
```

### Input

Single-line text input with horizontal scrolling.

```typescript
const input = new Input();
input.onSubmit = (value) => console.log(value);
input.setValue("initial");
input.getValue();
```

**Key Bindings:**

- `Enter` - Submit
- `Ctrl+A` / `Ctrl+E` - Line start/end
- `Ctrl+W` or `Alt+Backspace` - Delete word backwards
- `Ctrl+U` - Delete to start of line
- `Ctrl+K` - Delete to end of line
- `Ctrl+Left` / `Ctrl+Right` - Word navigation
- `Alt+Left` / `Alt+Right` - Word navigation
- Arrow keys, Backspace, Delete work as expected

### Editor

Multi-line text editor with autocomplete, file completion, and paste handling.

```typescript
interface SymbolTheme {
	cursor: string;
	ellipsis: string;
	boxRound: {
		topLeft: string;
		topRight: string;
		bottomLeft: string;
		bottomRight: string;
		horizontal: string;
		vertical: string;
	};
	boxSharp: {
		topLeft: string;
		topRight: string;
		bottomLeft: string;
		bottomRight: string;
		horizontal: string;
		vertical: string;
		teeDown: string;
		teeUp: string;
		teeLeft: string;
		teeRight: string;
		cross: string;
	};
	table: {
		topLeft: string;
		topRight: string;
		bottomLeft: string;
		bottomRight: string;
		horizontal: string;
		vertical: string;
		teeDown: string;
		teeUp: string;
		teeLeft: string;
		teeRight: string;
		cross: string;
	};
	quoteBorder: string;
	hrChar: string;
	spinnerFrames: string[];
}

interface EditorTheme {
	borderColor: (str: string) => string;
	selectList: SelectListTheme;
	symbols: SymbolTheme;
}

const editor = new Editor(theme);
editor.onSubmit = (text) => console.log(text);
editor.onChange = (text) => console.log("Changed:", text);
editor.disableSubmit = true; // Disable submit temporarily
editor.setAutocompleteProvider(provider);
editor.borderColor = (s) => chalk.blue(s); // Change border dynamically
```

**Features:**

- Multi-line editing with word wrap
- Slash command autocomplete (type `/`)
- File path autocomplete (press `Tab`)
- Large paste handling (>10 lines creates `[paste #1 +50 lines]` marker)
- Horizontal lines above/below editor
- Fake cursor rendering (hidden real cursor)

**Key Bindings:**

- `Enter` - Submit
- `Shift+Enter`, `Ctrl+Enter`, or `Alt+Enter` - New line (terminal-dependent, Alt+Enter most reliable)
- `Tab` - Autocomplete
- `Ctrl+K` - Delete line
- `Alt+D` / `Alt+Delete` - Delete word forward
- `Ctrl+A` / `Ctrl+E` - Line start/end
- `Ctrl+-` - Undo last edit
- Arrow keys, Backspace, Delete work as expected

### Markdown

Renders markdown with syntax highlighting and theming support.

```typescript
interface MarkdownTheme {
	heading: (text: string) => string;
	link: (text: string) => string;
	linkUrl: (text: string) => string;
	code: (text: string) => string;
	codeBlock: (text: string) => string;
	codeBlockBorder: (text: string) => string;
	quote: (text: string) => string;
	quoteBorder: (text: string) => string;
	hr: (text: string) => string;
	listBullet: (text: string) => string;
	bold: (text: string) => string;
	italic: (text: string) => string;
	strikethrough: (text: string) => string;
	underline: (text: string) => string;
	highlightCode?: (code: string, lang?: string) => string[];
	symbols: SymbolTheme;
}

interface DefaultTextStyle {
	color?: (text: string) => string;
	bgColor?: (text: string) => string;
	bold?: boolean;
	italic?: boolean;
	strikethrough?: boolean;
	underline?: boolean;
}

const md = new Markdown(
	"# Hello\n\nSome **bold** text",
	1, // paddingX
	1, // paddingY
	theme, // MarkdownTheme
	defaultStyle, // optional DefaultTextStyle
	2, // optional code block indent (spaces)
);
md.setText("Updated markdown");
```

**Features:**

- Headings, bold, italic, code blocks, lists, links, blockquotes
- HTML tags rendered as plain text
- Optional syntax highlighting via `highlightCode`
- Padding support
- Render caching for performance

### Loader

Animated loading spinner.

```typescript
const loader = new Loader(
	tui, // TUI instance for render updates
	(s) => chalk.cyan(s), // spinner color function
	(s) => chalk.gray(s), // message color function
	"Loading...", // message (default: "Loading...")
);
loader.start();
loader.setMessage("Still loading...");
loader.stop();
```

### CancellableLoader

Extends Loader with Escape key handling and an AbortSignal for cancelling async operations.

```typescript
const loader = new CancellableLoader(
	tui, // TUI instance for render updates
	(s) => chalk.cyan(s), // spinner color function
	(s) => chalk.gray(s), // message color function
	"Working...", // message
);
loader.onAbort = () => done(null); // Called when user presses Escape
doAsyncWork(loader.signal).then(done);
```

**Properties:**

- `signal: AbortSignal` - Aborted when user presses Escape
- `aborted: boolean` - Whether the loader was aborted
- `onAbort?: () => void` - Callback when user presses Escape

### SelectList

Interactive selection list with keyboard navigation.

```typescript
interface SelectItem {
	value: string;
	label: string;
	description?: string;
	hint?: string; // Autocomplete hint consumed by Editor; SelectList does not render it
	disabled?: boolean; // Dimmed, unselectable entry (see "Disabled items")
}

interface SelectListTheme {
	selectedPrefix: (text: string) => string;
	selectedText: (text: string) => string;
	description: (text: string) => string;
	scrollInfo: (text: string) => string;
	noMatch: (text: string) => string;
	symbols: SymbolTheme;
}

const list = new SelectList(
	[
		{ value: "opt1", label: "Option 1", description: "First option" },
		{ value: "opt2", label: "Option 2", description: "Second option" },
	],
	5, // maxVisible
	theme, // SelectListTheme
);

list.onSelect = (item) => console.log("Selected:", item);
list.onCancel = () => console.log("Cancelled");
list.onSelectionChange = (item) => console.log("Highlighted:", item);
list.setFilter("opt"); // Filter items
list.setSelectedIndex(1); // Select first enabled item at/after index 1, then search backward
```

**Controls:**

- Arrow keys: Navigate and wrap at list edges
- PageUp/PageDown: Move by a visible page and clamp at list boundaries
- Enter: Select
- Escape: Cancel

**Disabled items:**

Items with `disabled: true` stay visible but can never be selected:

- They render dimmed (via `theme.description`) and never show the selection cursor.
- Arrow keys wrap while skipping disabled entries; PageUp/PageDown skip disabled targets and clamp at list boundaries.
- Filtering (`setFilter`) resets the selection to the first *enabled* item.
- `setSelectedIndex(i)` selects the first enabled item at or after the clamped index, falling back backward.
- `onSelect` and `onSelectionChange` never receive a disabled item.
- When every visible item is disabled, `getSelectedItem()` returns `null` and no
  row shows a cursor. Arrow keys wrap the viewport, PageUp/PageDown clamp it,
  and the scroll indicator reports `(-/N)` without claiming a selected row.

### SettingsList

Settings panel with value cycling and submenus.

```typescript
interface SettingItem {
	id: string;
	label: string;
	description?: string;
	currentValue: string;
	values?: string[]; // If provided, Enter/Space cycles through these
	submenu?: (currentValue: string, done: (selectedValue?: string) => void) => Component;
}

interface SettingsListTheme {
	label: (text: string, selected: boolean) => string;
	value: (text: string, selected: boolean) => string;
	description: (text: string) => string;
	cursor: string;
	hint: (text: string) => string;
}

const settings = new SettingsList(
	[
		{ id: "theme", label: "Theme", currentValue: "dark", values: ["dark", "light"] },
		{ id: "model", label: "Model", currentValue: "gpt-4", submenu: (val, done) => modelSelector },
	],
	10, // maxVisible
	theme, // SettingsListTheme
	(id, newValue) => console.log(`${id} changed to ${newValue}`),
	() => console.log("Cancelled"),
);
settings.updateValue("theme", "light");
```

**Controls:**

- Arrow keys: Navigate
- Enter/Space: Activate (cycle value or open submenu)
- Escape: Cancel

### Spacer

Empty lines for vertical spacing.

```typescript
const spacer = new Spacer(2); // 2 empty lines (default: 1)
```

### Image

Renders images inline for terminals that support the Kitty graphics protocol (Kitty, Ghostty, WezTerm) or iTerm2 inline images. Falls back to a text placeholder on unsupported terminals.

```typescript
interface ImageTheme {
	fallbackColor: (str: string) => string;
}

interface ImageOptions {
	maxWidthCells?: number;
	maxHeightCells?: number;
	filename?: string;
}

const image = new Image(
	base64Data, // base64-encoded image data
	"image/png", // MIME type
	theme, // ImageTheme
	options, // optional ImageOptions
);
tui.addChild(image);
```

Supported formats: PNG, JPEG, GIF, WebP. Dimensions are parsed from the image headers automatically.

## Autocomplete

### CombinedAutocompleteProvider

Supports both slash commands and file paths.

```typescript
import { CombinedAutocompleteProvider } from "@gajae-code/tui";
import { getProjectDir } from "@gajae-code/utils";

const provider = new CombinedAutocompleteProvider(
	[
		{ name: "help", description: "Show help" },
		{ name: "clear", description: "Clear screen" },
		{ name: "delete", description: "Delete last message" },
	],
	getProjectDir(), // base path for file completion
);

editor.setAutocompleteProvider(provider);
```

**Features:**

- Type `/` to see slash commands
- Press `Tab` for file path completion
- Works with `~/`, `./`, `../`, and `@` prefix
- Filters to attachable files for `@` prefix

## Key Detection

Helper functions for detecting keyboard input (supports Kitty keyboard protocol):

```typescript
import {
	isEnter,
	isEscape,
	isTab,
	isShiftTab,
	isArrowUp,
	isArrowDown,
	isArrowLeft,
	isArrowRight,
	isCtrlA,
	isCtrlC,
	isCtrlE,
	isCtrlK,
	isCtrlO,
	isCtrlP,
	isCtrlLeft,
	isCtrlRight,
	isAltLeft,
	isAltRight,
	isShiftEnter,
	isAltEnter,
	isShiftCtrlO,
	isShiftCtrlD,
	isShiftCtrlP,
	isBackspace,
	isDelete,
	isHome,
	isEnd,
	// ... and more
} from "@gajae-code/tui";

if (isCtrlC(data)) {
	process.exit(0);
}
```

## Differential Rendering

The TUI uses three rendering strategies:

1. **First Render**: Output all lines without clearing scrollback
2. **Width Changed or Change Above Viewport**: Clear screen and full re-render
3. **Normal Update**: Move cursor to first changed line, clear to end, render changed lines

All updates are wrapped in **synchronized output** (`\x1b[?2026h` ... `\x1b[?2026l`) for atomic, flicker-free rendering.

## Terminal Interface

The TUI works with any object implementing the `Terminal` interface:

```typescript
interface Terminal {
	start(onInput: (data: string) => void, onResize: () => void): void;
	stop(): void;
	write(data: string): void;
	get columns(): number;
	get rows(): number;
	moveBy(lines: number): void;
	hideCursor(): void;
	showCursor(): void;
	clearLine(): void;
	clearFromCursor(): void;
	clearScreen(): void;
}
```

**Built-in implementations:**

- `ProcessTerminal` - Uses `process.stdin/stdout`
- `VirtualTerminal` - For testing (uses `@xterm/headless`)

## Utilities

```typescript
import { Ellipsis, visibleWidth, truncateToWidth, wrapTextWithAnsi } from "@gajae-code/tui";

// Get visible width of string (ignoring ANSI codes, uses Bun.stringWidth)
const width = visibleWidth("\x1b[31mHello\x1b[0m"); // 5

// Truncate string to width (preserving ANSI codes, adds ellipsis)
const truncated = truncateToWidth("Hello World", 8); // "Hello…" (default: Ellipsis.Unicode)

// Truncate without ellipsis
const truncatedNoEllipsis = truncateToWidth("Hello World", 8, Ellipsis.Omit); // "Hello Wo"

// Wrap text to width (Bun.wrapAnsi word wrap, trims line ends, preserves ANSI)
const lines = wrapTextWithAnsi("This is a long line that needs wrapping", 20);
// ["This is a long line", "that needs wrapping"]
```

## Creating Custom Components

When creating custom components, **each line returned by `render()` must not exceed the `width` parameter**. The TUI will error if any line is wider than the terminal.

### Handling Input

Use the key detection utilities to handle keyboard input:

```typescript
import { isEnter, isEscape, isArrowUp, isArrowDown, isCtrlC, isTab, isBackspace } from "@gajae-code/tui";
import type { Component } from "@gajae-code/tui";

class MyInteractiveComponent implements Component {
	private selectedIndex = 0;
	private items = ["Option 1", "Option 2", "Option 3"];

	onSelect?: (index: number) => void;
	onCancel?: () => void;

	handleInput(data: string): void {
		if (isArrowUp(data)) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
		} else if (isArrowDown(data)) {
			this.selectedIndex = Math.min(this.items.length - 1, this.selectedIndex + 1);
		} else if (isEnter(data)) {
			this.onSelect?.(this.selectedIndex);
		} else if (isEscape(data) || isCtrlC(data)) {
			this.onCancel?.();
		}
	}

	render(width: number): string[] {
		return this.items.map((item, i) => {
			const prefix = i === this.selectedIndex ? "> " : "  ";
			return truncateToWidth(prefix + item, width);
		});
	}
}
```

### Handling Line Width

Use the provided utilities to ensure lines fit:

```typescript
import { visibleWidth, truncateToWidth } from "@gajae-code/tui";
import type { Component } from "@gajae-code/tui";

class MyComponent implements Component {
	private text: string;

	constructor(text: string) {
		this.text = text;
	}

	render(width: number): string[] {
		// Option 1: Truncate long lines
		return [truncateToWidth(this.text, width)];

		// Option 2: Check and pad to exact width
		const line = this.text;
		const visible = visibleWidth(line);
		if (visible > width) {
			return [truncateToWidth(line, width)];
		}
		// Pad to exact width (optional, for backgrounds)
		return [line + " ".repeat(width - visible)];
	}
}
```

### ANSI Code Considerations

`visibleWidth()`, `truncateToWidth()`, and `wrapTextWithAnsi()` correctly handle ANSI escape codes:

- `visibleWidth()` ignores ANSI codes when calculating width (via `Bun.stringWidth`)
- `truncateToWidth()` preserves ANSI codes and properly closes them when truncating
- `wrapTextWithAnsi()` preserves ANSI codes while word-wrapping and trimming line ends

```typescript
import chalk from "chalk";

const styled = chalk.red("Hello") + " " + chalk.blue("World");
const width = visibleWidth(styled); // 11 (not counting ANSI codes)
const truncated = truncateToWidth(styled, 8); // Red "Hello" + " W..." with proper reset
```

### Caching

For performance, components should cache their rendered output and only re-render when necessary:

```typescript
class CachedComponent implements Component {
	private text: string;
	private cachedWidth?: number;
	private cachedLines?: string[];

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const lines = [truncateToWidth(this.text, width)];

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}
```

## Example

See `test/chat-simple.ts` for a complete chat interface example with:

- Markdown messages with custom background colors
- Loading spinner during responses
- Editor with autocomplete and slash commands
- Spacers between messages

Run it:

```bash
npx tsx test/chat-simple.ts
```

## Development

```bash
# Install dependencies (from monorepo root)
npm install

# Run type checking
npm run check

# Run the demo
npx tsx test/chat-simple.ts
```
