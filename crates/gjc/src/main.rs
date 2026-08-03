//! `gjc` — single-binary coding agent runtime.
//!
//! Rust host that replaces the Bun entry point (`packages/gajae-code/bin/gjc.js`).
//! Migration strategy: this binary owns the process; subsystems are ported from
//! TypeScript in dependency order. Anything not yet ported (browser tooling,
//! background jobs, TS plugins/extensions) runs as a subprocess.

mod cli;

use anyhow::Result;
use clap::Parser;

fn main() -> Result<()> {
	let args = cli::Cli::parse();
	tokio::runtime::Builder::new_multi_thread()
		.enable_all()
		.build()?
		.block_on(cli::run(args))
}
