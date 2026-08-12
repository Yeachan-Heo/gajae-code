# rust-skills

First-party GJC plugin that vendors the rust-skills corpus and two-layer rules so enable/disable gates injection.

## What it provides

- **Skill:** `rust-skills` — 265 best-practice rules across 26 categories (ownership, errors, async, unsafe, API design, and more).
- **Rulebook rule** (`rules/rust-skills.md`): listed in the system prompt when editing Rust files (`globs: **/*.rs`).
- **TTSR auto-inject** (`rules/rust-skills-inject.md`): injected once per session on the first `edit`/`write` of a `*.rs` file (`condition: "*.rs"`, `repeatMode: once`, `interruptMode: never`).

Disable the plugin to stop both the skill advertisement and the rule injection.

## Lifecycle

```sh
gjc plugin install rust-skills@gajae-code
gjc plugin enable rust-skills
gjc plugin disable rust-skills
gjc plugin upgrade rust-skills
gjc plugin uninstall rust-skills
```

## Attribution

Corpus vendored from [leonardomso/rust-skills](https://github.com/leonardomso/rust-skills) v1.5.1 (MIT). Packaging and the two GJC rule files are by Gajae Code. See `skills/rust-skills/LICENSE`.
