//! CLI surface for the `gjc` binary.
//!
//! Mirrors the top-level commands exposed by the Bun CLI so the Rust binary can
//! take over as the installed `gjc` entry point while subsystems are ported.

use anyhow::{Result, bail};
use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(name = "gjc", version, about = "gajae-code coding agent")]
pub struct Cli {
	#[command(subcommand)]
	pub command: Option<Command>,

	/// Initial prompt to run non-interactively.
	#[arg(short, long)]
	pub prompt: Option<String>,
}

#[derive(Subcommand)]
pub enum Command {
	/// Start the interactive TUI session (default).
	Run,
	/// Serve the Agent Client Protocol over stdio.
	Acp,
	/// Print resolved configuration as JSON.
	Config,
}

#[allow(clippy::unused_async, reason = "stubs; ported subsystems will await")]
pub async fn run(cli: Cli) -> Result<()> {
	match cli.command.unwrap_or(Command::Run) {
		Command::Run => bail!("not yet ported: interactive session (phase: agent core)"),
		Command::Acp => bail!("not yet ported: ACP server (phase: agent core)"),
		Command::Config => bail!("not yet ported: config resolution (phase 0)"),
	}
}
