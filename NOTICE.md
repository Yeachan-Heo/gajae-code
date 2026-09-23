# Notices

Gajae-Code builds on lessons from a small family of agent harnesses and keeps attribution visible:

- [`oh-my-pi`](https://github.com/can1357/oh-my-pi) — the upstream red-claw lineage and implementation DNA.
- [`oh-my-codex`](https://github.com/Yeachan-Heo/oh-my-codex) — Codex-focused orchestration experiments.
- [`oh-my-claudecode`](https://github.com/Yeachan-Heo/oh-my-claudecode) — Claude Code workflow exploration.
- [`insane-search`](https://github.com/fivetaku/insane-search) — MIT-licensed public-route fetch engine by @fivetaku, vendored as the safe `insane` fallback/search provider lineage.
- [`Markit`](https://github.com/Michaelliv/markit) — MIT-licensed document converter, pinned to `markit-ai` 0.5.3 under `packages/coding-agent/vendor/markit-ai`. Its license, upstream package metadata, integrity/hash inventory and reproducible patch are retained alongside the vendored code; MuPDF remains separately licensed as described below.

## MuPDF WebAssembly

PDF extraction uses MuPDF.js, copyright (C) 2004–2026 Artifex Software, Inc., distributed under [GNU Affero General Public License version 3 or later](https://www.gnu.org/licenses/agpl-3.0.html). MuPDF is provided without warranty; the repository's MIT license does not replace MuPDF's license. Alternative commercial licensing is available from [Artifex](https://artifex.com/).

The pinned dependency is `mupdf` 1.28.0. Artifex publishes its [1.28.0 source archive](https://mupdf.com/downloads/archive/mupdf-1.28.0-source.tar.gz), including the MuPDF.js [WebAssembly build instructions](https://github.com/ArtifexSoftware/mupdf/blob/205b8cf43551279d1215e88fe2845c5d595bade9/platform/wasm/BUILDING.md). Standalone release CI rebuilds the WASM from that pinned archive with Emscripten 4.0.8 and requires byte-for-byte equality with the pinned npm WASM before embedding it. The GitHub Release includes the corresponding source archive, build recipe, notices, and provenance alongside the binaries.

Release maintainers must still satisfy applicable combined-work licensing, license-copy, and Corresponding Source requirements when redistributing those binaries; this notice or a successful build check alone is not license clearance.
