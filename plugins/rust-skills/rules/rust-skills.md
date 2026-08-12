---
description: Rust best practices (rust-skills). Read when writing, reviewing, or refactoring Rust code.
globs:
  - "**/*.rs"
---

# Rust guidance (rust-skills)

You are working in Rust. The full corpus lives in the rust-skills skill — locate via skill discovery:

- Index: `SKILL.md` in the rust-skills skill
- Per-rule detail: `rules/<rule-id>.md` in the rust-skills skill

Read the index once before non-trivial Rust work; read specific rule files when a category is load-bearing for the change.

Project standards outrank this rule. If the repository defines its own Rust/error-handling/dependency policies (AGENTS.md, docs/standards/), those win on conflict.

## Critical priorities (always apply)

- **Ownership** (`own-`): prefer `&T` over `.clone()`; accept `&[T]`/`&str`, never `&Vec<T>`/`&String`; `Cow` for conditional ownership; move large types.
- **Errors** (`err-`): `thiserror` for libraries, `anyhow` for applications; `Result` + `?`; no `unwrap()` in production; `expect()` only for invariants; preserve source chains; lowercase messages.
- **Memory** (`mem-`): `with_capacity` when size known; box large enum variants; reuse allocations in loops; no `format!` when a literal or `write!` works.
- **Unsafe** (`unsafe-`): `// SAFETY:` comment on every block; `# Safety` section on every unsafe fn; minimal scope; `MaybeUninit` never `mem::zeroed`; Miri in CI.
- **Async** (`async-`): never hold `Mutex`/`RwLock` across `.await`; `spawn_blocking` for CPU work; bounded channels for backpressure; cancellation-safe `select!` branches.
- **Numeric** (`num-`): explicit overflow handling (`checked_`/`saturating_`/`wrapping_`); `TryFrom` for narrowing casts, never bare `as`; no `==` on floats.

## Task → category map

| Task | Read categories |
|---|---|
| New function | `own-`, `err-`, `name-`, `pat-` |
| New struct / public API | `api-`, `type-`, `conv-`, `doc-` |
| Async / concurrency | `async-`, `conc-`, `own-` |
| Unsafe / FFI | `unsafe-`, `type-`, `test-` |
| Serde | `serde-`, `type-` |
| Perf tuning | `opt-`, `mem-`, `perf-` |
| Code review | `anti-`, `lint-` |
