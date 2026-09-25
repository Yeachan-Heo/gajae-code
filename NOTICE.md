# Notices

Gajae-Code builds on lessons from a small family of agent harnesses and keeps attribution visible:

- [`oh-my-pi`](https://github.com/can1357/oh-my-pi) — the upstream red-claw lineage and implementation DNA.
- [`oh-my-codex`](https://github.com/Yeachan-Heo/oh-my-codex) — Codex-focused orchestration experiments.
- [`oh-my-claudecode`](https://github.com/Yeachan-Heo/oh-my-claudecode) — Claude Code workflow exploration.
- [`insane-search`](https://github.com/fivetaku/insane-search) — MIT-licensed public-route fetch engine by @fivetaku, vendored as the safe `insane` fallback/search provider lineage.
- [`Markit`](https://github.com/Michaelliv/markit) — MIT-licensed document converter, pinned to `markit-ai` 0.5.3 under `packages/coding-agent/vendor/markit-ai`. Its license, upstream package metadata, integrity/hash inventory and reproducible patch are retained alongside the vendored code.

- [`pdf-inspector`](https://crates.io/crates/pdf-inspector) — MIT-licensed PDF inspector maintained by Firecrawl, used with its default Rust features for native PDF-to-Markdown conversion.

## Notice history

MuPDF.js under AGPL-3.0-or-later was removed from the PDF conversion path; version 0.17.6 was the last release that shipped it.
