---
description: Auto-injects the rust-skills pointer once per session on the first Rust file edit.
condition: "*.rs"
interruptMode: never
repeatMode: once
---

You are working on Rust code. Once this session, read `rule://rust-skills` (Rust best-practices digest; full corpus in the rust-skills skill — locate via skill discovery). Project standards outrank this guidance on conflict.

Non-negotiables while you work: no `unwrap()` in production paths; `// SAFETY:` comment on every unsafe block; never hold locks across `.await`; `TryFrom` for narrowing casts, never bare `as`; `thiserror` for libraries, `anyhow` for applications.
