# Herdr as a terminal runtime backend for GJC lanes — evaluation (issue #4145)

- **Date:** 2026-08-10
- **Branch:** `research/issue-4145-herdr-r2` (base `dev` = `6923930921b4a6f1c0d1efc3922b797ba5d505c8`, #4144)
- **Herdr evaluated:** v0.8.0 (Linux x86_64, downloaded privately to `.herdr-local/`, never installed, no global config touched)
- **Evidence:** bounded local probe against a private named Herdr session (`HERDR_SESSION=probe`, config under a scratch XDG dir, server stopped and scratch dir removed after the run) + Herdr upstream docs/CLI at herdr.dev / herdrdev/herdr @ v0.8.0
- **Bottom line:** **Adapter-only experiment; not adopt as the production lane backend today.** GJC runs fine *inside* a Herdr pane, and Herdr is a good *interactive host*, but Herdr cannot provide GJC's persisted-tmux lane contract for *unattended, operator-owned, provably-identified* lanes: server restart loses the lane processes, GJC is not a detected/resumed agent, there is no kernel-provable exact-owner identity, and lifecycle authority is Herdr's screen manifest, not GJC's SDK/ACP. Details and blockers below.

---

## 1. What the current persisted-tmux contract requires

GJC's lane runtime lives in `packages/coding-agent/src/gjc-runtime/` (`tmux-common.ts`, `tmux-sessions.ts`, `tmux-gc.ts`, `tmux-owner-isolation.ts`, `tmux-provider-context.ts`, `launch-tmux.ts`, `team-*.ts`). The contract that a replacement backend must satisfy:

1. **Session identity** — a named, taggable session (`gajae_code_*`) with tmux user options carrying GJC ownership metadata: `@gjc-profile=1`, `@gjc-session-id`, `@gjc-session-state-file`, `@gjc-owner-generation`, `@gjc-owner-server-key`, `@gjc-branch*`, `@gjc-project`, `@gjc-version` (`tmux-common.ts`).
2. **Exact owner identity** — a **kernel-proven** server (`server_pid` + `/proc` start-time + cgroup classification, `TmuxServerProof.pidProven`), and an **exact pane owner** (`pane_pid` + `/proc/<pid>/stat` start-time) with a persisted generation and socket key. Cleanup refuses with `gjc_tmux_owner_unverifiable` / `gjc_tmux_owner_changed:<...>` when any of those cannot be re-proven (`tmux-owner-isolation.ts`, `tmux-sessions.ts:1273-1364`).
3. **Owner-resident process ownership** — the GJC owner runs **inside** the lane terminal as the pane process; on Linux it is placed in a dedicated `systemd-run --user --scope` cgroup (`gjc-tmux-owner.service`), classified `safe` only when the cgroup path shows a user/session/app/init/gjc `.scope` (tmux-owner-isolation `classifyCgroup`), and force-close signals the *exact* PID after re-proving its start-time.
4. **Worktree cwd** — the session starts with `new-session -c <cwd>`; worktrees are GJC-created (`gjc --worktree` / `team-launch.ts`) with the pane cwd inside the checkout.
5. **Detach/reattach** — `attach-session` / `kill-session`; detach leaves the server + owner alive; reattach reconnects the client to the same live owner process.
6. **Agent state** — GJC's SDK/ACP is the workflow/session authority; the terminal backend must not intercept or re-derive session semantics from scrollback.
7. **SDK endpoint discovery** — the owner (inside the lane) discovers and serves the session's SDK endpoint; the control plane reads it from session state (`harness-control-plane/sdk-transport.ts`).
8. **Cleanup** — GC enumerates tagged sessions, re-proves ownership, sends a validated SIGTERM verdict, then compatibility `kill-session`; refuses anything untagged/foreign (`tmux-gc.ts`, `tmux-sessions.ts` force-close).
9. **Concurrent lane isolation** — each `gjc --tmux` lane is its own named session; `gjc team` splits worker panes off the tagged leader and keeps heartbeat/claim isolation per worker (`team-runtime.ts`).

---

## 2. What Herdr v0.8.0 actually provides (verified + docs)

### 2.1 Verified on this machine (bounded probe)

| Probe | Result |
| --- | --- |
| Binary | `herdr 0.8.0`, Linux x86_64, downloaded to `.herdr-local/bin/herdr`; no install, no global PATH/config change |
| Server lifecycle | `herdr server` runs headless; `herdr status server` reports `version 0.8.0`, `protocol 19`, `compatible yes`; `herdr server stop` stops cleanly |
| Named sessions | `HERDR_SESSION=probe` + `XDG_CONFIG_HOME` redirect gives a private socket `…/sessions/probe/herdr.sock` (per-session sockets are a documented feature; note Unix `sun_path` limit 108 → use short config paths) |
| Workspace/pane creation | `herdr workspace create --cwd <repo> --label lane-a --no-focus` → `w1:p1`; second workspace → `w2:p1`; per-workspace cwd honored (`foreground_cwd` = repo) |
| GJC inside Herdr | `herdr pane run w1:p1 "cd <repo> && bun packages/coding-agent/src/cli.ts --version"` → `gjc/0.12.21`; `--smoke-test` → `smoke-test: ok` (after native addon build; same as any other terminal) |
| Env injection | managed panes get `HERDR_ENV=1`, `HERDR_PANE_ID`, `HERDR_TAB_ID`, `HERDR_WORKSPACE_ID`, `HERDR_SOCKET_PATH`; Herdr-managed vars are authoritative over caller env |
| Process ownership | `pane process-info --pane w1:p1` → `shell_pid` + foreground `argv/cwd`; pane close kills the pane's process group (verified: `sleep 300` died on `pane close`, survived cross-workspace close of the other lane) |
| Concurrent lanes | two workspaces ran commands concurrently with no cross-talk; closing lane A left lane B's process alive |
| Detach/reattach | TUI client attach/detach via `ctrl+b q`; server keeps running; reattach shows the same live lanes |
| Server restart | `kill -9` of the server then restart → **layout restored (workspaces/tabs/panes/cwd) but processes gone**; restored panes are fresh shells (`$` prompt); session.json saved on close, cleared on clean shutdown |
| SDK endpoint authority | GJC's own SDK endpoint discovery is untouched; no Herdr reference exists in `packages/coding-agent/src` (0 matches for `herdr`) |
| Worktrees | `herdr worktree create --cwd <repo-root-workspace> --branch probe/herdr-wt --base HEAD` → checkout at `~/.herdr/worktrees/gajae-code/probe-herdr-wt` on the requested branch/base; GJC CLI ran inside it; `herdr worktree remove --workspace w5 --force` cleaned it (branch preserved) |
| Agent detection | `agent list` returns `[]` for GJC panes; `agent wait` → `agent_not_found` (GJC is not a recognized agent); `pane wait-output`/`pane read` work for text-based control |

### 2.2 Documented (herdr.dev v0.8.0 docs)

- **Live persistence** = detach/reattach (`ctrl+b q` / `herdr`); processes keep running. **Snapshot restore** (server restart) restores layout/cwd/focus but **not** processes, scrollback, or sessions — panes return as new shells. Pane screen-history replay is experimental and off by default (`[experimental] pane_history = true`). Native agent session resume requires an **official Herdr integration**; GJC is **not** in the supported list (Pi, OMP, Claude Code, Codex, Copilot, Devin, Droid, Kimi, Qoder, Cursor, Grok, OpenCode, Kilo, Hermes, MastraCode, Antigravity).
- **Agent lifecycle authority** = Herdr's screen-manifest detection (or installed lifecycle integrations). Custom agents can report state via `pane report-agent --source custom:<id>` and release with `pane release-agent`; state is Herdr-owned, display-only metadata via `report-metadata`.
- **Socket API** (newline-delimited JSON over a Unix socket; protocol version; `herdr api schema --json`): full method catalog — server, session (`session.snapshot`), workspace, tab, pane (split/swap/move/zoom/layout/resize/read/send-input/close/process-info/report-agent…), layout (`layout.export`/`apply`, BSP tree, **does not preserve live PTYs or running processes**), agent, events, worktree (create/open/remove), integrations, plugins.
- **CLI** (all socket wrappers): `herdr status`, `session list/attach/stop/delete`, `workspace/tab/pane/agent/worktree/plugin` commands, `server stop/reload-config`, `update [--handoff]`.
- **Live handoff** (`herdr update --handoff`, `--remote --handoff`) is experimental opt-in; it keeps pane processes across a server replacement but does not preserve in-flight requests/waits/subscriptions.
- **Socket paths**: `~/.config/herdr/herdr.sock` or `~/.config/herdr/sessions/<name>/herdr.sock`; resolution order `--session` → `HERDR_SOCKET_PATH` → `HERDR_SESSION` → default.

---

## 3. Dimension-by-dimension mapping to the persisted-tmux contract

| Contract dimension (GJC today) | Herdr v0.8.0 reality | Verdict |
| --- | --- | --- |
| **Lifecycle** (create/tag/attach/kill session; owner stays resident) | Herdr owns the server+session lifecycle; `workspace.create`/`tab.create`/`pane.split` create lanes; `pane.close`/`workspace.close`/`session stop/delete` end them. GJC would be a *guest* — Herdr's server restart kills GJC owners and restores shells only. | **Gap (blocking for unattended lanes):** no GJC-owned durable lane lifecycle across Herdr server restarts. |
| **Persistence** | Detach/reattach keeps processes; snapshot restore is layout-only; agent resume requires an official integration (GJC absent). | **Partial:** interactive persistence yes; crash/restart persistence **no** for GJC processes. |
| **Process ownership** | Pane processes are Herdr's children; `pane.process_info` reports pid/argv/cwd, but Herdr does not expose GJC's `@gjc-*` tags, generation, or server-key proof; no cgroup claim. GJC's exact-owner kernel proof (`/proc` start-time + cgroup classification + persisted generation) has no Herdr analog. | **Gap (blocking for force-close/GC safety):** cannot prove "this exact lane, this exact generation, this exact server" the way `tmux-sessions.ts` does; `gjc_tmux_owner_*` fail-closed checks would not be expressible. |
| **Worktree cwd** | `worktree.create`/`open` manage git worktrees as workspaces with correct pane cwd; verified. GJC's own `--worktree` flow is independent. | **OK for hosting** (works); GJC keeps its own worktree management. |
| **Detach/reattach** | `ctrl+b q` detach + `herdr` reattach; verified keeps processes and lanes. | **OK** (interactive). |
| **Agent state** | Herdr derives agent lifecycle from screen manifests; GJC is not detected → `agent wait`/`agent prompt` unusable on GJC lanes without a custom reporter; GJC's SDK/ACP stays the session authority, which is the desired split — but Herdr gives no native value for GJC state and its manifest may misclassify TUI activity. | **Adapter opportunity:** GJC can report `idle/working/blocked` via `pane report-agent --source gjc:<session>` for *display*; must not become authority. |
| **SDK endpoint discovery** | Unaffected: owner discovers/serves its own endpoint from session state; Herdr adds `HERDR_SOCKET_PATH` (useful as an opt-in discovery hint for the SDK broker/daemon). | **OK** (orthogonal). |
| **Cleanup** | `pane.close` kills the pane process group (verified); `session stop/delete` exists; but GC-style *ownership re-proof before kill* is absent — anyone with socket access can close any pane. | **Gap (blocking):** GJC's "prove owner, then SIGTERM with verdict, then kill-session" safety has no Herdr equivalent. |
| **Concurrent lane isolation** | Workspaces are isolated (verified: separate pids, separate env identity, close isolation); one server process hosts all lanes. | **OK for isolation**, but all lanes share one server → one crash/restart kills every lane's processes (tmux: per-session server or shared server? tmux uses one server for all sessions too, but GJC tags and GCs per session and the *processes* survive server restarts because tmux servers are long-lived daemons; Herdr's server restart semantics differ — see 2.2). |

---

## 4. Blocker register (what must change before adopt)

1. **P0 — No kernel-provable exact-owner identity.** GJC's force-close/GC contract requires proving `(server pid, server start-time, pane pid, pane start-time, generation, server key)` before any destructive action. Herdr exposes no tag/claim API, no per-pane start-time/pid pair that outlives the pane, and no cgroup promise. Any adapter that "kills by pane id" would fail GJC's own `gjc_tmux_owner_unverifiable` bar.
2. **P0 — Server restart loses lane processes.** Snapshot restore is layout-only; GJC owners (the actual session processes) die with the Herdr server. Unattended GJC lanes must survive; the only Herdr path is experimental opt-in live handoff, which is for updates/remote attach, not crash recovery.
3. **P0 — No native agent session resume for GJC.** `resume_agents_on_restore` covers official integrations only; GJC is not one. Even a custom `report-agent-session` reference is display-only — Herdr "requires Herdr to know how to launch that agent and resume the referenced session", which is exactly the SDK authority GJC must keep for itself.
4. **P1 — GJC team coupling.** `gjc team` requires a tmux leader (`gjc_team_requires_tmux_leader`, `team-runtime.ts`) and uses tmux send-keys/options; running the leader in Herdr would still need tmux for the team backend, or a Herdr adapter for split/send/read. No Herdr support exists in `packages/coding-agent/src` (0 references).
5. **P1 — Lifecycle authority inversion.** Herdr's screen-manifest detection and `idle`-seen semantics (focus-dependent) would fight GJC's SDK/ACP turn state; the adapter must only *report* state, never let Herdr gate GJC.
6. **P2 — Sockets + config path limits.** Unix socket paths are limited to `sun_path` (108 bytes) — a concern for deeply nested worktrees/config dirs (probe hit this at 103 bytes under `~/Workspace/...`); mitigation is short config dirs or `HERDR_SOCKET_PATH`.
7. **P2 — npm name collision.** npm `herdr` is a reserved placeholder (v0.0.0, 699B, unrelated author); the real product ships as a binary from herdr.dev / GitHub releases. Any install automation must pin the release asset, not npm.

---

## 5. Recommendation

**Adapter-only experiment (do not adopt as the production lane backend; do not merge a backend swap).**

Herdr v0.8.0 is a polished interactive terminal workspace manager and a *great host* for a GJC session (verified: `gjc/0.12.21` runs, smoke-test passes, lanes isolate, detach/reattach works, worktrees work). But it is not a drop-in for GJC's persisted-tmux *lane contract*:

- It cannot survive its own server restart with GJC processes (layout-only restore),
- it has no exact-owner proof primitive GJC's GC/force-close can rely on,
- GJC is not a detected/resumed agent, and
- `gjc team` is hard-wired to tmux.

The valuable experiment is a **bounded adapter** that keeps GJC SDK/ACP as authority and treats Herdr as the *visible host*:

1. A `gjc --tmux`-equivalent that, when `HERDR_ENV=1` / `HERDR_SOCKET_PATH` is present, uses Herdr's socket API (via `HERDR_BIN_PATH` CLI wrappers or the NDJSON socket) for `workspace`/`tab`/`pane` creation, `pane.run`/`pane.read`/`pane.wait-output` for control, and `pane.report-agent --source gjc:<session>` for display-only lifecycle.
2. GJC keeps session state, SDK endpoint, and ownership on its own `.gjc/` side; Herdr is never the authority and never gates SDK/ACP.
3. `HERDR_SOCKET_PATH` is already injected into managed panes — the adapter can treat it as an opt-in SDK broker discovery hint (mirrors how `HERDR_PANE_ID` identifies the lane).
4. Unattended durability must remain tmux-backed (the current contract) until Herdr gains process-preserving restart + an ownership/claim API; revisit when those land (watch `resume_agents_on_restore`-style general hooks and a stable `pane.report-agent`-based session resume for arbitrary agents).

**Blockers to recheck before any adopt vote:** (a) process-preserving server restart for arbitrary panes (non-experimental), (b) an exact-pane owner/claim primitive with kernel proof, (c) generic agent session resume (not integration-list-gated), (d) team-worker support without tmux.

---

## 6. Evidence pointers

- Probe logs/commands: private `.herdr-local/` (gitignored) + this document; all probe servers stopped (`herdr server stop`), scratch dir `/tmp/gjc-herdr-probe` removed.
- Upstream docs read at v0.8.0: `/docs/session-state/`, `/docs/agents/`, `/docs/integrations/`, `/docs/socket-api/`, `/docs/cli-reference/`, `/docs/agent-automation/`, `/docs/install/`; schema dumped via `herdr api schema --json` (90 request methods).
- GJC contract source: `packages/coding-agent/src/gjc-runtime/{tmux-common,tmux-sessions,tmux-gc,tmux-owner-isolation,tmux-provider-context,launch-tmux,team-runtime}.ts`; docs `docs/environment-variables.md` (tmux/team sections).

— *[repo owner's gaebal-gajae (clawdbot) 🦞]*
