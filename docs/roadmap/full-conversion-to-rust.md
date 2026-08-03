# Full Conversion to Rust — Roadmap

Goal: ship `gjc` as a **single Rust binary** with zero Bun/Node runtime dependency,
eliminating the Bun memory leak class entirely.

Status: phase 0 started. Host binary skeleton lives at `crates/gjc/`.

## Locked decisions

| Question | Decision |
|---|---|
| Migration style | Strangler: Rust binary is the host from day one; TS shrinks per phase. No big-bang rewrite. |
| Browser tooling (puppeteer/CDP) | Subprocess. Not linked into the binary. |
| Background jobs / daemons | Subprocess, supervised by the Rust host. |
| TS plugins / extensions / custom tools | Subprocess protocol (spawned like MCP servers). No embedded JS engine. |
| NAPI layer (`pi-natives`) | Dissolved. Its ~32K lines become plain Rust libs consumed directly by `crates/gjc`. |
| Schema source of truth | `schemas/config.schema.json` + session file format are the compatibility contract (zod → serde/schemars). |

## Inventory (what must move)

| TS package | LOC | Fate |
|---|---|---|
| `packages/utils` | 10K | Port (mechanical) |
| `packages/stats` | 5K | Port (mechanical) |
| `packages/ai` | 142K | Port (provider clients, streaming, auth) |
| `packages/agent` | 36K | Port (agent loop, compaction) |
| `packages/coding-agent` | 876K | Port core; subsystems triaged below |
| `packages/tui` | 48K | Port (custom TUI layer on crossterm-level primitives) |
| `packages/bridge-client` | 1K | Absorbed into host |
| `packages/natives*` | — | Deleted (NAPI packaging shims) |
| `packages/gajae-code` | — | Replaced by `crates/gjc` binary |

Existing Rust head start (~66K lines): `pi-natives` (fs/search/edit/PTY backends),
`pi-shell` (brush-based shell), `pi-ast` (tree-sitter, 50+ grammars), `pi-iso`,
`gjc-sdk` (control protocol), plus the full dependency stack already in
`Cargo.toml` (grep-*, ignore, portable-pty, syntect, image, html-to-markdown-rs, …).

## Phases

Each phase ends with the binary passing its gate (see Verification) and the
corresponding TS code deleted or demoted to subprocess.

### Phase 0 — Contract & skeleton (in progress)

- [x] `crates/gjc` host binary: tokio + clap skeleton (`run`, `acp`, `config`)
- [ ] `gjc-config` crate: serde types generated/hand-derived from
      `schemas/config.schema.json`; loader with the same precedence rules
      (project `.gjc/` → user config dir → env)
- [ ] `gjc-session` crate: read/write the existing session file format
      byte-compatibly; golden-file tests against real `.gjc` session trees
- [ ] Gate: `gjc config` output diffs clean against the Bun CLI on real configs

### Phase 1 — Foundations

- [ ] Port `packages/utils` + `packages/stats` → `gjc-util`, `gjc-stats`
- [ ] Convert `pi-natives` from NAPI exports to a plain lib (`panic = "abort"`
      note in root `Cargo.toml` becomes obsolete once NAPI is gone)
- [ ] Logging/telemetry plumbing (tracing)

### Phase 2 — AI provider layer (`packages/ai`, 142K)

The largest genuinely portable chunk. Order by usage:

- [ ] Streaming core: SSE/eventstream decoding (reqwest + hand-rolled SSE;
      AWS eventstream framing already exists in TS as reference)
- [ ] Providers, first wave: `anthropic`, `openai-responses`, `openai-completions`,
      `google` (covers daily-driver usage)
- [ ] Auth: OAuth flows (`auth-broker`, `auth-gateway`), keychain/credential storage,
      AWS SigV4, Google auth
- [ ] Second wave: bedrock, vertex, azure, copilot, ollama, cursor, codex, kimi,
      dashscope, gitlab-duo, synthetic, mock
- [ ] Model registry: `models.json` embedded via `include_str!`, pricing, thinking metadata
- [ ] Gate: recorded-fixture streaming tests per provider + one live smoke per first-wave provider

### Phase 3 — Agent core (`packages/agent`, 36K)

- [ ] Agent loop, turn state machine, tool-call dispatch
- [ ] Compaction / context-window management
- [ ] Run collector, resource ledger, telemetry
- [ ] Gate: one full non-interactive turn end-to-end
      (`gjc -p "…"` → provider stream → tool call → result) with TUI still Bun-side

### Phase 4 — Tools (`packages/coding-agent/src/tools`)

Triage of ~70 tools:

- **Re-wire (Rust backend already exists in `pi-natives`/`pi-ast`/`pi-shell`):**
  `read`, `write`, `edit`, `search`, `find`, `bash` (+PTY), `ast-edit`, `ast-grep`,
  `archive-reader`, `sqlite-reader`
- **Port (pure logic):** `todo-write`, `calculator`, `checkpoint`, `context`,
  `json-tree`, `jtd-*`, renderers/formatters, `fetch` (reqwest + readability port
  or `html-to-markdown-rs` with accepted quality delta), `image-gen`
- **Subprocess:** `browser`/`puppeteer`, `computer`, `job`/`cron`/`monitor`
  (long-lived daemons), `telegram-send`, `irc`, `ssh` (spawn ssh), `render-mermaid`
- [ ] Tool registry + permission/approval engine in Rust
- [ ] Gate: default-toolset parity checklist; per-tool golden IO tests

### Phase 5 — Runtime services (`packages/coding-agent`, the long tail)

Largest and least mechanical; slice by subsystem, each independently gated:

- [ ] Session/resume/checkpoint, hooks, slash commands, modes, system prompts,
      skills (`skill-discovery` reads SKILL.md — pure fs, easy)
- [ ] MCP client (+ `runtime-mcp`, `coordinator-mcp`) — rmcp or hand-rolled JSON-RPC
- [ ] Extensibility host: subprocess protocol for TS plugins/extensions/custom tools
      (`bun`/`node` spawned only if the user has plugins; binary itself stays clean)
- [ ] ACP server (`gjc acp`)
- [ ] LSP/DAP clients, git integration, memories/hindsight, goals/workflows
- [ ] Deferred/drop candidates (decide per-item when reached): `stt`, `eval`,
      `autoresearch`, `deep-interview`, `harness-control-plane`

### Phase 6 — TUI (`packages/tui` + `coding-agent/src/tui`, ~90K)

Last, because it has the most surface and the least leak risk once the core is Rust.

- [ ] Terminal layer: raw mode, bracketed paste, capabilities detection
      (crossterm or existing `pi-natives` terminal code)
- [ ] Component tree: editor, autocomplete, markdown rendering (syntect already in-tree),
      images (sixel/kitty — `icy_sixel` already in-tree)
- [ ] Keybindings, vim mode, kill ring
- [ ] Gate: daily-drive dogfooding; Bun TUI kept behind a flag until parity

### Phase 7 — Cutover

- [ ] `gjc` npm package ships the Rust binary (platform packages) with a JS-free `bin`
- [ ] Delete `packages/*` TS runtime code; keep plugin SDK types published for
      subprocess plugin authors
- [ ] Remove NAPI/`napi-*` deps, `bun-imports.d.ts`, build-native pipeline
- [ ] CI: cargo-dist style release matrix replaces Bun compile

## Verification strategy

1. **Contract tests first**: golden files for config resolution and session format
   (phase 0) prevent silent breakage of existing user state.
2. **Fixture-driven provider tests**: record real SSE streams once, replay in CI.
3. **Parity harness**: run the Bun CLI and Rust binary side-by-side on a scripted
   task corpus; diff transcripts/tool IO until phase 6.
4. **Dogfooding gate per phase**: each phase's feature is used for real work before
   the TS counterpart is deleted.

## Risks

- **`coding-agent` is 876K lines**: the triage in phases 4–5 is where scope control
  happens; anything not used weekly should be deferred or subprocess'd, not ported.
- **Session-format drift during migration**: freeze the format at phase 0; any format
  change lands in both runtimes until cutover.
- **Provider auth edge cases** (OAuth refresh, keychain differences per OS) are the
  usual long tail — budget for it in phase 2.
- **TUI parity is subjective**: keep the Bun TUI available behind a flag until
  dogfooding says otherwise.
