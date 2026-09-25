//! Structural analysis of a shell command using `brush-parser`.
//!
//! The minimizer must not corrupt downstream parsing or stitch together
//! segments that emit interleaved output. This module parses the full
//! command with the same shell parser the vendored brush runtime uses and
//! classifies it into one of a few shapes the engine can reason about.
//!
//! ## Decisions encoded here
//!
//! - **Pipes are opaque.** Any `foo | bar` pipeline is marked as `Piped`
//!   regardless of what `bar` is. A user piping through `awk`, `jq`, `rg`, or
//!   any other consumer is almost certainly parsing the output; rewriting it
//!   would be a correctness bug. The engine falls back to passthrough.
//! - **Compound commands are opaque.** `a && b`, `a ; b`, and `a || b` cannot
//!   be minimized as one combined buffer without risking semantic corruption,
//!   so they are left unchanged.
//! - **Single simple commands** are safe for the whole-buffer path; the engine
//!   dispatches them through `detect.rs` as before.
//!
//! When the command fails to parse (syntax error, unsupported construct),
//! we return `Unsupported` and the engine passes through.

use brush_parser::{
	ParserOptions,
	ast::{AndOrList, Command, CompoundListItem, Pipeline, Program, SeparatorOperator},
};

/// Outcome of analyzing a raw command string.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CommandPlan {
	/// Exactly one simple command. `program` is the leading word (without
	/// arguments), verbatim from the parsed AST.
	Single { program: String },
	/// The command contains at least one `|` pipeline. We intentionally do
	/// NOT identify upstream / downstream programs here — any pipe defeats
	/// safe minimization for this engine.
	Piped,
	/// The command has multiple segments joined by `&&`, `||`, `;`, or `&`.
	/// This shape is left unchanged; the minimizer only rewrites whole simple
	/// command output.
	Compound,
	/// Parse failed, a compound shell construct (for loops, subshells, etc.)
	/// was encountered, or the command was empty.
	Unsupported,
}

/// Parse `command` with `brush-parser` and classify its structure.
pub fn analyze(command: &str) -> CommandPlan {
	let trimmed = command.trim();
	if trimmed.is_empty() {
		return CommandPlan::Unsupported;
	}

	let options = ParserOptions::default();
	let reader = std::io::Cursor::new(command.as_bytes());
	let mut parser = brush_parser::Parser::new(reader, &options);

	let Ok(program) = parser.parse_program() else {
		return CommandPlan::Unsupported;
	};

	classify(&program)
}

fn classify(program: &Program) -> CommandPlan {
	// Count separator-separated top-level items across all complete_commands.
	let items: Vec<&CompoundListItem> = program
		.complete_commands
		.iter()
		.flat_map(|cl| cl.0.iter())
		.collect();

	if items.is_empty() {
		return CommandPlan::Unsupported;
	}

	if items.len() > 1 {
		// `a ; b` or `a & b` produces multiple compound list items.
		return CommandPlan::Compound;
	}

	// Exactly one CompoundListItem: check the separator and the AndOrList.
	let CompoundListItem(and_or, separator) = items[0];

	// Async separator (`&`) backgrounds the command; treat as compound since
	// the parent shell's stdout is the foreground command's — we don't know
	// which one we're capturing. Conservative bail.
	if matches!(separator, SeparatorOperator::Async) {
		return CommandPlan::Compound;
	}

	// AndOrList.additional holds the `&&` / `||` continuations.
	if !and_or.additional.is_empty() {
		return CommandPlan::Compound;
	}

	// Only a single pipeline at this point.
	classify_pipeline(&and_or.first).unwrap_or_else(|| classify_andorlist(and_or))
}

fn classify_pipeline(pipeline: &Pipeline) -> Option<CommandPlan> {
	if pipeline.seq.len() > 1 {
		return Some(CommandPlan::Piped);
	}
	let single = pipeline.seq.first()?;
	match single {
		Command::Simple(simple) => {
			let program_word = simple.word_or_name.as_ref()?;
			let program_text = program_word.to_string();
			if program_text.trim().is_empty() {
				return None;
			}
			Some(CommandPlan::Single { program: program_text })
		},
		// Compound shell syntax (if / for / while / subshell / { ... }) is
		// not something the minimizer should touch.
		Command::Compound(..) | Command::Function(_) | Command::ExtendedTest(..) => {
			Some(CommandPlan::Compound)
		},
	}
}

const fn classify_andorlist(_and_or: &AndOrList) -> CommandPlan {
	CommandPlan::Unsupported
}

#[cfg(test)]
mod tests {
	use super::*;

	fn program_of(plan: CommandPlan) -> Option<String> {
		match plan {
			CommandPlan::Single { program } => Some(program),
			_ => None,
		}
	}

	#[test]
	fn single_simple_command() {
		let plan = analyze("git status --short");
		assert_eq!(program_of(plan), Some("git".to_string()));
	}

	#[test]
	fn env_prefix_is_still_single() {
		// env assignments are prefix, the program is `git`.
		let plan = analyze("FOO=1 git status");
		assert!(matches!(plan, CommandPlan::Single { .. }));
	}

	#[test]
	fn pipe_is_piped() {
		assert_eq!(analyze("git status | cat"), CommandPlan::Piped);
		assert_eq!(analyze("ls -la | awk '{print $1}'"), CommandPlan::Piped);
	}

	#[test]
	fn and_or_is_compound() {
		assert_eq!(analyze("cd foo && cargo test"), CommandPlan::Compound);
		assert_eq!(analyze("foo || bar"), CommandPlan::Compound);
	}

	#[test]
	fn sequence_is_compound() {
		assert_eq!(analyze("echo a ; echo b"), CommandPlan::Compound);
	}

	#[test]
	fn async_is_compound() {
		assert_eq!(analyze("sleep 1 &"), CommandPlan::Compound);
	}

	#[test]
	fn empty_is_unsupported() {
		assert_eq!(analyze(""), CommandPlan::Unsupported);
		assert_eq!(analyze("   "), CommandPlan::Unsupported);
	}

	#[test]
	fn subshell_is_compound_not_single() {
		// `(cmd)` is a compound-command variant, not Simple.
		let plan = analyze("(cd foo && make)");
		assert!(matches!(plan, CommandPlan::Compound | CommandPlan::Unsupported));
	}

	#[test]
	fn malformed_is_unsupported() {
		assert_eq!(analyze("a && && b"), CommandPlan::Unsupported);
	}
}
