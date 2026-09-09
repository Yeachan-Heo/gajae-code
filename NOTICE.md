# Notices

Gajae-Code builds on lessons from a small family of agent harnesses and keeps attribution visible:

- [`oh-my-pi`](https://github.com/can1357/oh-my-pi) — the upstream red-claw lineage and implementation DNA.
- [`oh-my-codex`](https://github.com/Yeachan-Heo/oh-my-codex) — Codex-focused orchestration experiments.
- [`oh-my-claudecode`](https://github.com/Yeachan-Heo/oh-my-claudecode) — Claude Code workflow exploration.
- [`insane-search`](https://github.com/fivetaku/insane-search) — MIT-licensed public-route fetch engine by @fivetaku, vendored as the safe `insane` fallback/search provider lineage.

## MuPDF WebAssembly

PDF extraction uses MuPDF.js, copyright (C) 2004–2026 Artifex Software, Inc., distributed under [GNU Affero General Public License version 3 or later](https://www.gnu.org/licenses/agpl-3.0.html). MuPDF is provided without warranty; the repository's MIT license does not replace MuPDF's license. Alternative commercial licensing is available from [Artifex](https://artifex.com/).

The pinned dependency is `mupdf` 1.28.0. Its upstream source and build instructions are available from [MuPDF](https://cgit.ghostscript.com/mupdf.git/) and [MuPDF.js documentation](https://mupdf.readthedocs.io/en/latest/). Standalone builds embed its WASM asset. Release maintainers must satisfy the applicable combined-work licensing, license-copy, and Corresponding Source requirements before redistributing those binaries; merely linking this notice is not a substitute for those obligations.
