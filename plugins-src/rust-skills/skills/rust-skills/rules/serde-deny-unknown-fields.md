# serde-deny-unknown-fields

> Reject unexpected keys with `#[serde(deny_unknown_fields)]`

## Why It Matters

By default, serde silently discards any key in the input that doesn't match a struct field. For user-facing config files and strict API contracts this is dangerous: a typo like `"timout_secs"` passes validation without error, and the intended field is simply never set. `#[serde(deny_unknown_fields)]` turns unrecognized keys into hard errors, surfacing mistakes immediately.

## Bad

```rust
use serde::{Serialize, Deserialize};
use serde_json;

#[derive(Serialize, Deserialize, Debug)]
struct ServerConfig {
    host: String,
    port: u16,
    timeout_secs: u64,
}

fn main() {
    // "timout_secs" is a typo — serde silently ignores it, timeout stays 0
    let json = r#"{"host":"localhost","port":8080,"timout_secs":30}"#;
    let cfg: ServerConfig = serde_json::from_str(json).unwrap();
    println!("{:?}", cfg); // timeout_secs is 0, not 30
}
```

## Good

```rust
use serde::{Serialize, Deserialize};
use serde_json;

#[derive(Serialize, Deserialize, Debug)]
#[serde(deny_unknown_fields)]
struct ServerConfig {
    host: String,
    port: u16,
    timeout_secs: u64,
}

fn parse_config(json: &str) -> Result<ServerConfig, serde_json::Error> {
    serde_json::from_str(json)
}

fn main() {
    // Typo is now a hard error
    let bad = r#"{"host":"localhost","port":8080,"timout_secs":30}"#;
    assert!(parse_config(bad).is_err());

    // Correct input still works
    let good = r#"{"host":"localhost","port":8080,"timeout_secs":30}"#;
    let cfg = parse_config(good).unwrap();
    println!("{:?}", cfg);
}
```

## Key Points

- Apply `deny_unknown_fields` to **config-file structs**, **request/response DTOs**, and any struct that forms a public API contract where typos must be caught.
- Skip it for **flexible or extensible** structs where callers are expected to pass extra metadata. Use `#[serde(flatten)]` with a `HashMap` catch-all instead.
- The attribute works with JSON, TOML, YAML, and most self-describing formats.
- Error messages name the unexpected field, making them actionable for end users.

## Caveats

`#[serde(deny_unknown_fields)]` is **incompatible with `#[serde(flatten)]`** on the same struct. `flatten` needs to pass unmatched keys down to the flattened field; `deny_unknown_fields` intercepts them first. If you need both behaviors, split the struct or use a two-pass approach (deserialize into a `serde_json::Value`, then convert).

## See Also

- [serde-flatten](serde-flatten.md) - inline nested structs or collect extra keys (incompatible with deny_unknown_fields)
- [api-parse-dont-validate](api-parse-dont-validate.md) - parse into validated types at boundaries
