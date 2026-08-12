# unsafe-no-mangle-unsafe

> In Rust 2024, write `#[unsafe(no_mangle)]`, `#[unsafe(export_name = "...")]`, and `#[unsafe(link_section = "...")]` — not the bare attribute forms.

## Why It Matters

`#[no_mangle]`, `#[export_name]`, and `#[link_section]` were reclassified as unsafe in Rust 2024 because they can cause undefined behavior without any `unsafe` block at the call site. If two items in the same binary share the same exported symbol name, the linker silently picks one and discards the other — the "winning" symbol may have a completely different type, signature, or semantics. The result is type-level UB with no diagnostic from the compiler or linker. Requiring `#[unsafe(...)]` makes this footgun visible and auditable.

## Bad

```rust
// Rust 2021 — bare attributes accepted, no warning about linker UB
#[no_mangle]
pub extern "C" fn init() {
    // ...
}

#[export_name = "plugin_entry"]
pub fn plugin_main() {
    // ...
}

#[link_section = ".init_array"]
static INIT: extern "C" fn() = init;
```

## Good

```rust
// Rust 2024 — unsafe(...) wrapper makes the risk explicit
#[unsafe(no_mangle)]
pub extern "C" fn init() {
    // ...
}

#[unsafe(export_name = "plugin_entry")]
pub fn plugin_main() {
    // ...
}

#[unsafe(link_section = ".init_array")]
static INIT: extern "C" fn() = init;
```

## Migration

| Rust 2021 | Rust 2024 |
|-----------|-----------|
| `#[no_mangle]` | `#[unsafe(no_mangle)]` |
| `#[export_name = "sym"]` | `#[unsafe(export_name = "sym")]` |
| `#[link_section = ".sec"]` | `#[unsafe(link_section = ".sec")]` |

Run `cargo fix --edition` when migrating to the 2024 edition — it rewrites bare attribute forms to `#[unsafe(...)]` automatically. Review each one afterward: confirm that the exported symbol name is unique across the binary.

## Key Points

- The `unsafe(...)` wrapper does **not** require an `unsafe {}` block at the call site; it marks the *attribute itself* as load-bearing for safety. The annotation documents that the programmer accepted responsibility for symbol uniqueness and ABI correctness.
- Symbol collisions are especially dangerous in plugin architectures, `cdylib` crates, embedded firmware with custom linker scripts, and any codebase that links multiple Rust crates into a single binary.
- These attributes interact with `unsafe extern` blocks (see `unsafe-extern-block`): external symbols you import and symbols you export follow the same 2024-edition safety rules.
- The bare forms (`#[no_mangle]` without `unsafe`) are a hard error in Rust 2024 edition code. They still compile in earlier editions but emit a deprecation warning with `--warn future-incompatible`.

## See Also

- [unsafe-extern-block](unsafe-extern-block.md) - wrap `extern` blocks in `unsafe extern` in Rust 2024
- [type-repr-transparent](type-repr-transparent.md) - use `#[repr(transparent)]` for FFI newtypes
