# lint-cfg-check

> Enable `unexpected_cfgs` and declare known cfgs to catch feature-gate typos

## Why It Matters

A typo in a cfg expression — `#[cfg(feature = "serde_")]` instead of `"serde"`, or `#[cfg(tokio_unstable)]` with no declaration — compiles silently and produces dead code or an always-disabled feature. The `unexpected_cfgs` lint (stabilized in Rust 1.80) flags any cfg name or value not known to the compiler. Cargo automatically teaches the compiler about your declared feature names; for custom cfgs (well-known ones like `tokio_unstable`, or your own) you must declare them via `check-cfg` in the `[lints.rust]` table. This catches bugs at compile time that would otherwise be invisible.

## Bad

```rust
// Typo: "serde_" will never match the "serde" feature.
// Compiles with no warning — the block is silently dead.
#[cfg(feature = "serde_")]
impl serde::Serialize for MyType {}

// Custom cfg used without declaration — also silently ignored.
#[cfg(tokio_unstable)]
pub fn experimental() {}
```

## Good

```toml
# Cargo.toml — declare custom cfgs in the lints table
[lints.rust]
unexpected_cfgs = { level = "warn", check-cfg = [
    'cfg(tokio_unstable)',
    'cfg(coverage_nightly)',
] }
```

```rust
// Now "serde_" typo → compiler warning: unexpected `cfg` condition value
// and tokio_unstable is a known cfg, so it compiles cleanly.
#[cfg(feature = "serde")]      // correct
impl serde::Serialize for MyType {}

#[cfg(tokio_unstable)]         // declared above — no warning
pub fn experimental() {}
```

## Workspace Projects

Configure the lint once at the workspace level and inherit it in member crates:

```toml
# Cargo.toml (workspace root)
[workspace.lints.rust]
unexpected_cfgs = { level = "warn", check-cfg = [
    'cfg(tokio_unstable)',
] }

# member/Cargo.toml
[lints]
workspace = true
```

## Notes

- Feature names (`feature = "serde"`, `feature = "std"`) are registered automatically by Cargo — you do not need to list them in `check-cfg`.
- Values in `check-cfg` entries must be quoted cfg expressions: `'cfg(name)'` or `'cfg(name, values("v1", "v2"))'`.
- The lint fires at `warn` level; promote to `deny` in CI if you want hard failures.

## See Also

- [lint-workspace-lints](lint-workspace-lints.md) - configure lints at workspace level
- [proj-feature-additive](proj-feature-additive.md) - design features to be strictly additive
- [lint-warn-suspicious](lint-warn-suspicious.md) - enable suspicious lint group
