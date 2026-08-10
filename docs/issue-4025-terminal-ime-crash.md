# Apple Terminal.app + Korean IME + raw-mode TUI host crash (issue #4025)

## Baseline

- Issue: [#4025](https://github.com/Yeachan-Heo/gajae-code/issues/4025) (open, `bug`, `P1`, `area:ux`, `effort:M`), reported by @jkf87.
- Dev head at disposition: `6923930921b4a6f1c0d1efc3922b797ba5d505c8` (`test(slash): expect provider-qualified selectors from /model assignment (#4144)`).
- Lane: **Linux-only** (Ubuntu, x64). No macOS host is available in this lane, so no physical reproduction of Apple Terminal.app behavior was possible. Nothing in this document claims a macOS reproduction or a fix for Apple's process crash.
- Related PRs: #4049 (merged — iTerm2 Option/Alt configuration only; explicitly **not** evidence for this crash) and #3693 (external, closed unmerged with `REQUEST_CHANGES` — proposed skipping `modifyOtherKeys` in Apple Terminal for a double-Return *composition* symptom, distinct from this host `SIGSEGV`).

## Crash report analysis (external evidence)

The reporter's `.ips` (Terminal-2026-08-08-104011.ips, macOS 26.5 / Terminal.app 2.15 / Korean 2-set `com.apple.inputmethod.Korean`):

```
exception: EXC_BAD_ACCESS (SIGSEGV)
           KERN_INVALID_ADDRESS at 0x0000000000000008
procName: Terminal (PID 717)
faultingThread: 0 (main thread)
  name: "(input method 942 com.apple.inputmethod.Korean)"

-[NSTextInputContext selectedRangeWithCompletionHandler:]   <- null deref
  <- -[NSTextInputContext handleTSMEvent:]
    <- IMKInputSession_Modern (Korean IME)
      <- TSMProcessRawKeyEvent
```

What this stack proves:

- The faulting process is **Terminal.app itself**, not GJC. The Korean input method (IMK) asks Terminal.app's `NSTextInputContext` for the current selection range while processing a raw key event (`TSMProcessRawKeyEvent`), and Terminal.app dereferences a null field (`0x8`).
- The fault happens **inside Terminal.app's text-input pipeline, before any key bytes are delivered to the PTY**. In macOS terminal emulators, IME composition is owned by the host app's `NSTextInputContext`; the application process only ever receives *committed* text. GJC therefore cannot observe, participate in, or serialize the composition.

What this stack does **not** prove:

- It does not prove a mechanism. "GJC redraws (`ESC[2K` + cursor motion) while the IME is composing, destabilizing the text view" is a plausible-sounding causal theory, but nothing in the stack or the report ties a specific byte sequence or render cadence to the null deref. The null field at `0x8` inside `selectedRangeWithCompletionHandler:` is consistent with a host-side lifecycle bug (e.g. the text view/input-context association being torn down or never established) that is independent of what the foreground app writes.

## What GJC can and cannot control

GJC's only interface to Terminal.app is a byte pipe: it writes escape sequences/UTF-8 to the PTY master and reads key/paste bytes from it. `ProcessTerminal` (`packages/tui/src/terminal.ts`) owns exactly this contract.

GJC **can** control (deterministically, from any OS):

1. Terminal capability detection (`packages/tui/src/terminal-capabilities.ts`; `TERMINAL_ID` from `TERM_PROGRAM` etc.).
2. Raw mode on its own PTY stdin (`setRawMode(true)` in `ProcessTerminal.start()`).
3. Keyboard protocol reprogramming: Kitty keyboard protocol query `CSI ? u` / push `CSI > 7u`, and the xterm `modifyOtherKeys` fallback `CSI > 4;2m` (`#queryAndEnableKittyProtocol`, `packages/tui/src/terminal.ts:784-819`).
4. What it renders, when, and with what framing: synchronized output `CSI ?2026h/l`, cursor visibility/shape, cursor positioning, line rewrites — all through the centralized render loop and write paths in `packages/tui/src/tui.ts`.
5. Bracketed paste (`CSI ?2004h`), mouse reporting, alternate-scroll mode.

GJC **cannot** control:

- Terminal.app's internal `NSTextInputContext` / IMK state machine, its marked-text view, or its `selectedRange` bookkeeping. Those live in the host process, upstream of the PTY. No sequence GJC writes to the PTY can make the IMK's `selectedRange` query safer, and no input GJC reads can influence it.

## GJC-controlled seams, verified on the pinned head

### 1. Enhanced keyboard input (`GJC_TUI_KEYBOARD_PROTOCOL`, default on)

`keyboardEnhancementEnabled()` (`packages/tui/src/terminal.ts:50-52`) gates both the Kitty query/push and the `modifyOtherKeys` fallback. The opt-out was added for Android Termius (#573): enhanced modes made Termius commit every intermediate composing jamo/syllable instead of only the final character. The win32 branch additionally skips the `modifyOtherKeys` fallback because it breaks Windows CJK/Hangul IME composition (Alt+Enter bypasses the IME commit; `packages/tui/src/terminal.ts:797-810`).

Direction of effect: the keyboard protocol changes how **Terminal.app encodes key events to the PTY**. It does not change how Terminal.app routes a raw key event through the IMK (`TSMProcessRawKeyEvent`) or how its `NSTextInputContext` tracks selection — those happen before encoding. So while this seam is the correct lever for *composition breakage* (Termius, Windows), it has **no credible mechanism** for the `selectedRange` null deref in #4025.

### 2. macOS IME block-cursor anchor (`GJC_TUI_IME_CURSOR`, default on for darwin)

`#useImeBlockCursor` (`packages/tui/src/tui.ts:937-940`) defaults to `process.platform === "darwin"`. When the soft cursor is active, the TUI shows a steady block cursor (`\x1b[2 q`) instead of hiding the hardware cursor, anchoring Terminal.app's IME overlay; standalone cursor nudges are deliberately written **outside** synchronized-output framing (`#writeCursorPosition`, `packages/tui/src/tui.ts:4556-4573`; comment: "synchronized output flushes terminal state and discards macOS IME composition"). This feature fixed the macOS CJK IME "ghost character" bug (#1150) and re-anchoring after repaints (#1880).

Direction of effect: this seam *stabilizes* the IME overlay interaction rather than destabilizing it. Disabling it (the `=0` escape hatch) is the supported workaround if a user suspects overlay/cursor interaction, but flipping the default would re-introduce a fixed macOS UX bug (#1150) on an unproven theory.

### 3. Synchronized-output framing (`GJC_TUI_SYNCHRONIZED_OUTPUT`, default on)

Frame writes use `CSI ?2026h/l`. Documented in-repo that framing flushes terminal state and discards macOS IME composition, which is why IME cursor writes are excluded. Disabling it is a process-wide compatibility switch, already documented in `docs/environment-variables.md`.

### 4. Render cadence

Rendering is **event-driven and differential**, not a continuous loop: `requestRender*` (`packages/tui/src/tui.ts:2060-2207`) coalesces to a 16 ms frame budget (`#MIN_RENDER_INTERVAL_MS`), expedites input renders via a next-tick path, and only writes changed lines. There is no fixed-rate repaint timer that redraws idle screens. The report's "frequent redraw" framing is therefore already bounded: repaint frequency is proportional to actual content changes (streaming tokens, keystrokes, resize), which is the minimal write cadence a live TUI can have.

### 5. Raw mode / cbreak

Bun's `setRawMode(true)` (full raw: `ICANON`/`ECHO`/`ISIG` off) is the only wired TUI stdin mode; there is no cbreak/termios path (`ProcessTerminal.start()`, `packages/tui/src/terminal.ts:341-351`). Even if cbreak existed, in a GUI terminal it changes PTY line discipline only — the IMK path runs in the host before bytes reach the PTY, so cbreak has no mechanism to reduce the host-side race described in #4025.

## Why no product-code change is justified from this lane

Per-candidate analysis (all four levers the report proposes, plus the terminal-specific ones):

| Candidate | Mechanism vs. this crash | Regression risk | Verdict |
|---|---|---|---|
| cbreak mode instead of full raw | None: IMK runs in the host, upstream of PTY line discipline | High: Bun exposes no cbreak path; changes key delivery for every terminal | Not justified |
| Redraw throttle/debounce | None demonstrated; cadence already event-driven + 16 ms coalesced + differential | High: input-latency regressions (history: "prioritize input renders", #593) | Not justified |
| Pause input processing during redraw | None: the race (if it is one) is inside Terminal.app, not between GJC input and GJC render | High: freezes the TUI's only interaction channel | Not justified |
| Auto-disable keyboard enhancement on Apple Terminal | None for THIS crash: protocol affects terminal→app key encoding, not the IMK `selectedRange` path; #3693 (rejected) claimed only a *composition* symptom | Medium: degrades modified-key chords for all Terminal.app users on an unproven theory | Not justified; `GJC_TUI_KEYBOARD_PROTOCOL=0` already covers the lever |
| Change `GJC_TUI_IME_CURSOR` default | Opposite direction: the anchor stabilizes the overlay | High: re-opens fixed macOS ghost-character bug (#1150) | Not justified |

The dispositive facts:

1. The faulting process is Terminal.app; the fault is a host-side null deref in its text-input path. No GJC-controlled byte sequence is shown (or, on the current evidence, mechanistically credible) to cause it.
2. Every lever that *could* be flipped either has no mechanism for this crash or degrades interactive key handling globally, on an unproven theory. The repo's own admission criteria (issue comments, 2026-08-09) require a current-release macOS reproduction plus an evidence-backed narrow TUI/TTY change; neither exists.
3. The existing seams are the supported bounded controls and are already implemented with deterministic Linux-runnable coverage (see below). Users who hit the crash have exact, documented escape hatches.

## Supported workaround (actionable, in precedence order)

1. **`GJC_TUI_KEYBOARD_PROTOCOL=0`** — leaves the keyboard in its default mode: no Kitty query/push, no `modifyOtherKeys`. This removes the only GJC-controlled reprogramming of Terminal.app's input handling and is the strongest available lever for any IME-composition interaction (the class of bug #573 and the win32 branch fix).
2. **`GJC_TUI_IME_CURSOR=0`** — disables the macOS steady-block IME cursor anchor and the extra standalone cursor writes.
3. **`GJC_TUI_SYNCHRONIZED_OUTPUT=0`** — removes `CSI ?2026h/l` framing if a terminal's 2026 handling misbehaves with the IME.
4. **Use iTerm2 / WezTerm / Kitty instead of Terminal.app** — the reporter's own mitigation; these terminals are not implicated in this crash class.
5. **Report the crash to Apple** (Feedback Assistant) with the preserved `.ips`; the fault is in `Terminal.app`'s `NSTextInputContext` handling and only Apple can fix the host process.

## Evidence required to admit a future code change (reproduction matrix)

From a macOS 26.x host, run the existing TUI repaint harness (`bun packages/tui/test/iterm-ime-smoke.ts`) in a fresh Terminal.app session with Korean 2-set active, and record four independent runs: baseline; `GJC_TUI_KEYBOARD_PROTOCOL=0`; `GJC_TUI_IME_CURSOR=0`; both disabled. Repeat the baseline in iTerm2 or WezTerm. Preserve any Terminal `.ips`. Capture OS/Terminal/Bun/GJC versions, input-source identifier, exact command/environment, composition/submit behavior, and whether Terminal itself crashes. Only a result that isolates a GJC-controlled sequence (e.g. the crash tracks `GJC_TUI_KEYBOARD_PROTOCOL` across the matrix) admits a narrow TUI/TTY candidate with focused tests plus macOS validation. No candidate exists today; nothing in this document should be read as one.

## Verification performed in this lane (Linux, exact head `6923930921`)

- Targeted seams, all green on head: `keyboard-protocol-optout.test.ts`, `input-render-redteam.test.ts` (IME cursor re-anchor), `render-commit.test.ts` (IME cursor write outside synchronized framing) — **18 pass / 0 fail**.
- Full TUI suite: **1073 pass / 6 skip / 0 fail** (1079 tests, 77 files) on head.
- Docs index regeneration: `bun --cwd=packages/coding-agent run generate-docs-index` (123 docs).
- No product source was modified. This document plus the `GJC_TUI_IME_CURSOR` documentation entry are the only changes.

## Disposition

**BOUNDED HOLD — no product code change and no PR.** The host-process crash is inside Apple Terminal.app's `NSTextInputContext` path, this lane cannot reproduce it, and no GJC-controlled change has a demonstrated mechanism for it. The bounded controls above are the supported workaround and remain fully documented and test-covered. A code change would be speculative and risks regressing interactive input, which the repo explicitly refuses to do without macOS admission evidence.

Signed-off-by: gaebal-gajae <gaebal-gajae@users.noreply.github.com>
