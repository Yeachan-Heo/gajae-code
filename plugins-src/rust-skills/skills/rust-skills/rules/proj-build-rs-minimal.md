# proj-build-rs-minimal

> Keep `build.rs` minimal, deterministic, and idempotent

## Why It Matters

Build scripts run on every Cargo invocation that touches their crate. Cargo decides whether to re-run a build script based on `cargo::rerun-if-changed` and `cargo::rerun-if-env-changed` directives: if you emit none, Cargo re-runs the script on every build; if you emit overly broad ones, you force unnecessary recompiles. Non-determinism (timestamps, UUIDs, network fetches) breaks reproducible builds, caching, and offline workflows. Parsing `rustc --version` strings to detect capabilities is fragile; the `autocfg` crate performs capability probes safely by compiling small snippets against the actual toolchain.

## Bad

```rust
// build.rs — overly broad, non-deterministic, network-dependent
use std::process::Command;

fn main() {
    // re-runs on every build because no rerun directives are emitted
    // (Cargo default: re-run if ANY file changes)

    // fragile: parses version string instead of probing capability
    let output = Command::new("rustc").arg("--version").output().unwrap();
    let version = String::from_utf8(output.stdout).unwrap();
    if version.contains("1.8") {
        println!("cargo::rustc-cfg=has_feature");
    }

    // network access breaks offline/reproducible builds
    let _resp = reqwest::blocking::get("https://example.com/schema.json").unwrap();
}
```

## Good

```rust
// build.rs — narrow directives, capability probe via autocfg, no network
fn main() {
    // Only re-run when these specific files change
    println!("cargo::rerun-if-changed=build.rs");
    println!("cargo::rerun-if-changed=src/generated.rs");
    println!("cargo::rerun-if-env-changed=MY_BUILD_FLAG");

    // Probe actual compiler capability instead of parsing version strings
    let ac = autocfg::new();
    // Emit cfg if the compiler supports the feature we need
    ac.emit_has_type("std::collections::BTreeMap");

    // Conditional cfg from env var
    if std::env::var("MY_BUILD_FLAG").is_ok() {
        println!("cargo::rustc-cfg=my_feature");
    }
}
```

```toml
[build-dependencies]
autocfg = "1"
```

## Guidelines

- Always emit at least `println!("cargo::rerun-if-changed=build.rs")` so the script only re-runs when it or its tracked inputs change.
- List every file the script reads: source files, schema files, code-gen templates. Missing a file means stale output; listing too many causes spurious rebuilds.
- Never make network calls. Download assets in advance and check them into the repo or use a `vendored` feature that ships them.
- Prefer `autocfg` or `rustversion` crates over parsing `rustc --version` for conditional compilation.
- Keep build scripts short. If codegen is complex, extract it into a library crate used by `build.rs`, not into `build.rs` itself.
- Avoid writing outside `OUT_DIR` (the directory Cargo provides for build output); writing elsewhere breaks sandboxed build environments.

## See Also

- [proj-feature-additive](proj-feature-additive.md) - design features to be strictly additive
- [lint-cfg-check](lint-cfg-check.md) - catch cfg typos with unexpected_cfgs
