# Native computer-use tool

Status: **in progress (draft)** — coordinate contract + native `screenshot`
capture landed and verified; input primitives, kill-switch, and napi/TS surface
to follow.

A new, model-agnostic `computer` tool that lets any model drive the user's real
macOS desktop via the OpenAI computer-use action set. Built fresh (the
open-source `openai/codex` repo has no GUI computer-use source to copy; only the
public action *schema* is mirrored).

This feature was scoped through GJC's deep-interview (requirements) and ralplan
(Planner/Architect/Critic consensus) workflows. The full deep-interview spec and
the consensus plan + ADR are the authoritative source of truth; this document is
the committed summary and roadmap.

## Locked decisions (ADR summary)

- **Target:** the user's real macOS desktop, OS-native control. Callable v1 support
  is Apple Silicon macOS only (`arm64` darwin); Intel macOS, Linux, and Windows are
  deferred behind the same tool schema.
- **Driver:** any model via a generic structured tool-call interface — no
  provider-specific computer-use API.
- **Action set:** the exact OpenAI computer-use primitives — `screenshot`,
  `click`, `double_click`, `move`, `drag`, `scroll`, `type`, `keypress`, `wait`.
- **Implementation:** built fresh in the Rust `pi-natives` crate (napi),
  exposed through `packages/natives` to a new
  `packages/coding-agent/src/tools/computer.ts`, kept deliberately lower-level
  than the existing `browser` tool (coordinate/input primitives only, no web
  semantics).
- **Coordinate contract:** a single normalized virtual display. The returned
  screenshot's pixel dimensions *are* the action coordinate space; Rust owns the
  transform to macOS logical points (Retina/HiDPI-safe) and display selection.
- **Permissions:** macOS TCC (Accessibility + Screen Recording) auto-preflighted;
  on a missing grant, open the relevant Settings pane and return a clear
  "grant then retry/relaunch" error.
- **Gating:** available by default on supported Apple Silicon macOS via
  `computer.alwaysOn` (default `true`); set `computer.alwaysOn=false` to disable
  default availability. `computer.enabled` remains a per-session manual enable path.
- **Safety:** no per-action approval (autonomous), **but** a daemon-enforced
  global kill-switch outside model control (global hotkey OR TUI stop key) that
  aborts queued actions, releases held keys/buttons, suspends further input, and
  snapshots the last screen. Reset is user-only, never via the model-facing tool.
- **Architecture:** every primitive delegates to one central Rust
  `execute_action` state machine (preflight, validation, cancellation, audit,
  screenshot policy, release-all) so per-primitive methods cannot drift past the
  safety contract. The in-process supervisor sits behind a `SupervisorClient`
  boundary so an out-of-process daemon can replace it later without changing the
  napi surface.

## Capture + coordinate contract (shipped)

`crates/pi-natives/src/computer/coords.rs` implements the pure, framework-free
core: `NormalizedDisplay` maps a screenshot-space pixel `(x, y)` to a macOS
logical point via per-axis scale and the display's logical origin, rejecting
out-of-bounds and non-finite inputs. It is unit-tested (scale 1.0/2.0,
fractional and anisotropic scale, non-zero origins, edges, out-of-bounds,
invalid scale) and requires no display or granted permissions.

`crates/pi-natives/src/computer/capture.rs` (macOS) implements the read-only
`screenshot` primitive: it captures the primary display via CoreGraphics into a
PNG and derives the `NormalizedDisplay` scale from captured physical pixels vs
logical bounds, surfacing a missing Screen Recording grant as
`CaptureError::CaptureFailed` (never a silent black frame). Verified live: a
real, non-uniform primary-display capture decodes as a PNG with matching
dimensions (`cargo test -p pi-natives --ignored captures_non_uniform_primary_display`).

## Delivery roadmap

Delivery ships a `screenshot`+`click`+`type` vertical slice first; the remaining
six primitives fast-follow; v1 acceptance = all nine primitives drive a real
macOS app end-to-end plus a kill-switch drill (per-primitive napi unit tests +
manual macOS E2E).

| Slice | Scope | Status |
|-------|-------|--------|
| Coordinate contract + planning docs | `coords` module + unit tests + this doc | **done (this PR)** |
| Native screen capture (`screenshot`) | `capture` module, primary display, PNG + scale | **done (this PR, verified live)** |
| TCC preflight (`permissions`) | Accessibility + Screen Recording checks, Settings openers, fail-closed guards | **done (this PR, verified live)** |
| napi screenshot binding (`computerScreenshot`) | napi → `packages/natives` → TS, verified live | **done (this PR)** |
| Native input orchestration (`input`) | `InputController` click/double_click/move/drag/scroll/type/keypress + release_all over an `EventSink` | **done (this PR)** — logic unit-tested; **live cursor-move injection verified** (Accessibility granted) |
| Central `execute_action` state machine | preflight + supervisor + cancellation + audit + release-all | planned |
| Kill-switch supervisor + global-hotkey event-tap | `supervisor` (fail-closed `input_allowed`, user-only reset) + `hotkey` CGEventTap on a CFRunLoop thread | **done (this PR)** — supervisor unit-tested; **synthetic-hotkey latch verified live** |
| Supervisor-gated `execute_action` + napi/TS `computer` tool | wire input through `input_allowed` + cancellation; `ComputerController` napi; `computer.ts` schema/gating/prompt/renderer | next |
| Manual macOS E2E acceptance | TextEdit all-nine + kill-switch drill | planned (requires macOS hardware + granted TCC + human operator) |

The remaining input backend, kill-switch, napi/TS surface, and manual
end-to-end acceptance still require injecting events into a live desktop and a
human-operated drill, so they are tracked as follow-up work rather than landed
in this draft.
