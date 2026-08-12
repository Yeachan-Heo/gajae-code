# proj-lib-main-split

> Keep `main.rs` minimal, logic in `lib.rs`

## Why It Matters

Putting your logic in `lib.rs` makes it testable, reusable, and keeps `main.rs` as a thin entry point. Integration tests can only access your library crate, not binary code in `main.rs`.

## Bad

```rust
// src/main.rs - everything here
fn main() {
    let args = parse_args();
    let config = load_config(&args.config_path).unwrap();
    let db = connect_database(&config.db_url).unwrap();
    
    // Hundreds of lines of application logic...
    // All untestable from integration tests!
}

fn parse_args() -> Args { /* ... */ }
fn load_config(path: &str) -> Result<Config, Error> { /* ... */ }
fn connect_database(url: &str) -> Result<Db, Error> { /* ... */ }
// ... more functions that can't be tested
```

## Good

```rust
// src/main.rs - thin entry point
use my_app::{run, Config};

fn main() -> anyhow::Result<()> {
    let config = Config::from_env()?;
    run(config)
}

// src/lib.rs - all the logic
pub mod config;
pub mod database;
pub mod handlers;

pub use config::Config;

pub fn run(config: Config) -> anyhow::Result<()> {
    let db = database::connect(&config.db_url)?;
    let app = handlers::build_app(db);
    app.run()
}
```

## With CLI Arguments

```rust
// src/main.rs
use clap::Parser;
use my_app::{run, Args};

fn main() -> anyhow::Result<()> {
    let args = Args::parse();
    run(args)
}

// src/lib.rs
use clap::Parser;

#[derive(Parser, Debug)]
#[command(name = "myapp", version, about)]
pub struct Args {
    #[arg(short, long)]
    pub config: PathBuf,
    
    #[arg(short, long, default_value = "info")]
    pub log_level: String,
}

pub fn run(args: Args) -> anyhow::Result<()> {
    // All application logic here - testable!
}
```

## Project Structure

```
my_app/
├── Cargo.toml
├── src/
│   ├── main.rs       # Entry point only
│   ├── lib.rs        # Library root, re-exports
│   ├── config.rs     # Configuration
│   ├── database.rs   # Database connection
│   └── handlers/     # Request handlers
│       ├── mod.rs
│       └── users.rs
└── tests/
    └── integration.rs  # Can access lib.rs!
```

## Testing Benefits

```rust
// tests/integration.rs - can test everything!
use my_app::{Config, run, database};

#[test]
fn test_database_connection() {
    let config = Config::test_config();
    let db = database::connect(&config.db_url).unwrap();
    assert!(db.is_connected());
}

#[test]
fn test_full_workflow() {
    let config = Config::test_config();
    // Test the actual run function
    assert!(my_app::run(config).is_ok());
}
```

## Multiple Binaries

```rust
// src/lib.rs - shared code
pub mod core;
pub mod utils;

// src/bin/server.rs
use my_app::core::Server;

fn main() -> anyhow::Result<()> {
    Server::new()?.run()
}

// src/bin/cli.rs
use my_app::core::Client;

fn main() -> anyhow::Result<()> {
    let client = Client::new()?;
    client.execute_command()
}
```

## See Also

- [proj-bin-dir](proj-bin-dir.md) - Put multiple binaries in src/bin/
- [proj-mod-by-feature](proj-mod-by-feature.md) - Organize modules by feature
- [test-integration-dir](test-integration-dir.md) - Integration tests in tests/
