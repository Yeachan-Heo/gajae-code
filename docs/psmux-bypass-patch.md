# Windows + psmux bypass for `gjc --tmux` (gjc 0.10.1)

## Background

gjc v0.10.1 added an **owner-isolation** gate to managed tmux launches. The
gate requires a Linux-style immutable owner identity (`/proc/<pid>/cgroup`
plus `start_time` proof), and **hard-refuses any multiplexer that cannot
prove its identity** with two `throw new Error("gjc_tmux_owner_isolation
_native_session_identity_unavailable")` calls.

On Windows the cgroup path is `not_applicable` in every case, so the gate
also rejects Windows + psmux despite no native alternative being available.

## Patch

Branch: `fix/psmux-bypass` (commit `bc735965`).
File: `packages/coding-agent/src/gjc-runtime/launch-tmux.ts`.

Both throw sites replaced with an empty diagnostic guard so the throw is
no longer raised on Windows + psmux. The legacy launch path downstream
already gracefully handles psmux:

- `new-session` is invoked without the psmux-incompatible `-P -F` flags
- `@gjc-profile` and friends are tagged when the session supports it
- the **psmux round-trip profile** keys (mouse, set-clipboard, mode-style)
  remain filtered when `GJC_PSMUX_PROFILE_FORCE` is not set (built-in
  prior to v0.9.0; preserved here)
- the `cleanupCreatedTmuxSession` guard already short-circuits for psmux
  via `if (plan.isPsmux) return false` in `isCreatedTmuxSessionIdentityStable`

## Verification

- `bun run scripts/test-launch-tmux-patch.ts` exercises both throw sites and
  returns `false` (no throw) in headless mode.
- `gjc -p "echo test"` continues to work (no regression).
- The installed `@gajae-code/coding-agent` in `~/.bun/bin/gjc` resolves
  through a `bun link` to this checked-out branch.

## How to run

In an interactive terminal (PowerShell, Windows Terminal, etc.):

```powershell
gjc --tmux
```

psmux is auto-discovered by `resolveGjcTmuxBinary` and used as the
tmux backend. The patch lets `launchDefaultTmuxIfNeeded` continue past
the owner-isolation refusal and the legacy launch flow attaches the
session normally.

## Known limitations

- Owner-isolation guarantees on Windows + psmux are weaker than native
  Linux tmux (no cgroup provenance). Sessions still work; idempotent
  cleanup depends on psmux's first-party session state.
- psmux's `set-option` round-trip for `@gjc-*` user options is historically
  unreliable (see tmux-common.ts comments); expect occasional
  "session untagged" diagnostics from `gjc session status`.
- A TTY is still required for `attach-session` to settle; running in
  headless `bash`/PowerShell-redirected sessions will hang at attach
  by design, not because of the patch.

## Reverting

```bash
git checkout origin/dev -- packages/coding-agent/src/gjc-runtime/launch-tmux.ts
bun install @gajae-code/coding-agent@link:@gajae-code/coding-agent
```
