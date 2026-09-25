# Notices

Gajae-Code builds on lessons from a small family of agent harnesses and keeps attribution visible:

- [`oh-my-pi`](https://github.com/can1357/oh-my-pi) — the upstream red-claw lineage and implementation DNA.
- MIT-licensed Rust diff primitives and N-API bridge vendored from `can1357/oh-my-pi` at `a85bd5228d9f0f619deade1db78fa49420a721e1` under `crates/pi-diff` and `crates/pi-natives/src/diff.rs`; see `crates/pi-diff/LICENSE`.
- SVG rasterization uses `resvg` and `png` under their MIT licenses; `crates/pi-natives/src/svg.rs` is vendored from `can1357/oh-my-pi` commit `a85bd5228d9f0f619deade1db78fa49420a721e1` (MIT).
- `pi-iso` — MIT-licensed crate source vendored from `can1357/oh-my-pi@a85bd5228d9f0f619deade1db78fa49420a721e1`; see [crates/pi-iso/LICENSE](crates/pi-iso/LICENSE).
- `crates/pi-natives/src/{text.rs,keys.rs}` include MIT-licensed code re-synced from oh-my-pi commit `a85bd5228d9f0f619deade1db78fa49420a721e1`.
- Mermaid rendering in `crates/pi-natives/src/mermaid/` is vendored from `can1357/oh-my-pi` commit `a85bd5228d9f0f619deade1db78fa49420a721e1` (MIT); the pinned Mermaid test corpus is retained in `crates/pi-natives/fixtures/mermaid.json`.
- `tty_writer.rs` is vendored from `can1357/oh-my-pi` commit `a85bd5228d9f0f619deade1db78fa49420a721e1` (MIT); native terminal writes run on a dedicated Unix thread.
- [`oh-my-codex`](https://github.com/Yeachan-Heo/oh-my-codex) — Codex-focused orchestration experiments.
- [`oh-my-claudecode`](https://github.com/Yeachan-Heo/oh-my-claudecode) — Claude Code workflow exploration.
- [`insane-search`](https://github.com/fivetaku/insane-search) — MIT-licensed public-route fetch engine by @fivetaku, vendored as the safe `insane` fallback/search provider lineage.
- [`Markit`](https://github.com/Michaelliv/markit) — MIT-licensed document converter, pinned to `markit-ai` 0.5.3 under `packages/coding-agent/vendor/markit-ai`. Its license, upstream package metadata, integrity/hash inventory and reproducible patch are retained alongside the vendored code.
- [`pdf-inspector`](https://crates.io/crates/pdf-inspector) — MIT-licensed PDF inspector maintained by Firecrawl, used with its default Rust features for native PDF-to-Markdown conversion.
- `pi-ast` — MIT-licensed AST language, pattern, and structural-summary support from oh-my-pi@a85bd5228d9f0f619deade1db78fa49420a721e1, vendored under `crates/pi-ast` with its upstream license retained.
- `pi-vfs` and `pi-walker` are MIT-licensed crates vendored at `a85bd5228d9f0f619deade1db78fa49420a721e1`; their retained license texts are in `crates/pi-vfs/LICENSE` and `crates/pi-walker/LICENSE`.

## Vendored Rust from oh-my-pi @ a85bd522

`crates/pi-natives/src/{js.rs,task.rs,testing.rs,utils.rs}` include MIT-licensed material from `can1357/oh-my-pi` at commit `a85bd5228d9f0f619deade1db78fa49420a721e1`. Per-file attribution and local modifications are recorded in each source file.

- The syntax-highlighting re-sync and six bundled `.sublime-syntax` files are derived from `can1357/oh-my-pi@a85bd5228d9f0f619deade1db78fa49420a721e1` and distributed under MIT.
- The PTY binding is derived from `crates/pi-natives/src/pty.rs` at the pinned commit and retains GJC's bounded output-loss reporting, ConPTY single-flight guard, and child cleanup.
- The process binding is derived from `crates/pi-natives/src/ps.rs` at the pinned commit and delegates process operations to the local `pi_shell::process`, retaining identity-aware observations and pinned-root signaling.

Copyright (c) 2025 Mario Zechner, 2025–2026 Can Bölük, and 2026 Stencil Labs, Inc. Per-file headers retain the upstream source path and local modifications.

## Vendored Rust modules

The files listed below are adapted from the MIT-licensed `can1357/oh-my-pi` source pinned to `a85bd5228d9f0f619deade1db78fa49420a721e1`; each source file carries its own attribution and local-modification header.
- `crates/pi-natives/src/grep.rs` is re-synced from the pinned source. `grep-pcre2` uses `PCRE2_SYS_STATIC=1` so PCRE2 is bundled into the addon rather than loaded from a host library; GJC omits the upstream-only injectable `shell::vfs` filesystem option.
- `crates/pi-natives/src/html.rs`
- `crates/pi-natives/src/sixel.rs`
- `crates/pi-natives/src/clipboard.rs`
- `crates/pi-natives/src/power.rs`
- `crates/pi-natives/src/prof.rs`
- `crates/pi-natives/src/appearance.rs`
- `crates/pi-natives/src/crash.rs` (alloc-error handling merged from `crash_handler.rs`)

## Notice history

MuPDF.js under AGPL-3.0-or-later was removed from the PDF conversion path; version 0.17.6 was the last release that shipped it.
