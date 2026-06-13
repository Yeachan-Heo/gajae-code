//! Conservative pre-execution rewrites for bash commands.
//!
//! Two fixups are applied, each anchored to the end of a top-level pipeline
//! (segments split on `;`, `&&`, `||`, and background `&`):
//!
//!  1. Trailing `| head [args]` / `| tail [args]` (and the `|&` variant) —
//!     these pipes exist purely to limit output length. The harness already
//!     truncates bash output and exposes the full result via an artifact, so
//!     the pipe just hides content the agent wanted.
//!
//!  2. A redundant trailing `2>&1` on a segment that has no remaining pipe or
//!     other redirect. The harness already merges stderr into stdout, so the
//!     duplication is purely cosmetic — and often a leftover after fixup (1)
//!     drops a downstream pipe.
//!
//! The implementation is AST-driven: `brush-parser` handles tokenization,
//! quoting, heredocs, command substitution, and nested compound commands. We
//! never re-implement those by hand. Source spans on `Pipeline`/`Command`
//! nodes give us byte-exact edit ranges; `IoRedirect` currently lacks a span,
//! so the `2>&1` strip uses a bounded textual scan inside the enclosing
//! simple command's source span.
//!
//! On any parse failure, multi-line input, or absence of an applicable
//! pattern, the function returns the input verbatim with `stripped` empty.

use std::{io::BufReader, sync::LazyLock};

use brush_parser::{Parser, ParserOptions, SourceInfo, ast::*};
use regex::Regex;

/// Result of [`apply_bash_fixups`].
#[derive(Debug, Clone, Default)]
pub struct BashFixupResult {
	/// Possibly-rewritten command. Equal to the input when no fixup fired.
	pub command:  String,
	/// Substrings removed, in source order. Suitable for a user-facing notice.
	pub stripped: Vec<String>,
}

/// Apply the bash fixups to `cmd`. See module docs for full rules.
pub fn apply_bash_fixups(cmd: &str) -> BashFixupResult {
	// Multi-line input is out of scope: heredoc/loop bodies can't be safely
	// rewritten and the agent rarely passes them as bash tool input. Bailing
	// early also keeps the per-call cost bounded.
	if cmd.contains('\n') || cmd.contains('\r') {
		return BashFixupResult { command: cmd.to_owned(), stripped: vec![] };
	}

	let options = ParserOptions::default();
	let source_info = SourceInfo::default();
	let mut reader = BufReader::new(cmd.as_bytes());
	let mut parser = Parser::new(&mut reader, &options, &source_info);
	let Ok(program) = parser.parse_program() else {
		return BashFixupResult { command: cmd.to_owned(), stripped: vec![] };
	};

	// `ranges` drives output construction; `stripped` is reported to the
	// caller. We keep them separate so reporting can stay in fixup order
	// (head/tail before `2>&1`) while edits sort by source position.
	let mut ranges: Vec<(usize, usize)> = Vec::new();
	let mut stripped: Vec<String> = Vec::new();

	// Walk only the top-level pipelines. Recursing into compound bodies (`if`,
	// loops, subshells) would risk changing semantics: e.g. stripping `head`
	// from `if cmd | head -5; then …; fi` swaps a header-check for a full
	// stream-check.
	for complete in &program.complete_commands {
		for CompoundListItem(and_or, _sep) in &complete.0 {
			walk_andor(and_or, cmd, &mut ranges, &mut stripped);
		}
	}

	if ranges.is_empty() {
		return BashFixupResult { command: cmd.to_owned(), stripped: vec![] };
	}

	ranges.sort_by_key(|(s, _)| *s);
	let mut out = String::with_capacity(cmd.len());
	let mut cursor = 0;
	for (s, e) in ranges {
		// Defensive: ranges should be disjoint by construction.
		if s < cursor {
			continue;
		}
		out.push_str(&cmd[cursor..s]);
		cursor = e;
	}
	out.push_str(&cmd[cursor..]);
	// Trim trailing horizontal whitespace introduced by removals at EOS.
	while matches!(out.as_bytes().last(), Some(b' ' | b'\t')) {
		out.pop();
	}

	BashFixupResult { command: out, stripped }
}

fn walk_andor(
	list: &AndOrList,
	cmd: &str,
	ranges: &mut Vec<(usize, usize)>,
	stripped: &mut Vec<String>,
) {
	process_pipeline(&list.first, cmd, ranges, stripped);
	for ao in &list.additional {
		let pipe = match ao {
			AndOr::And(p) | AndOr::Or(p) => p,
		};
		process_pipeline(pipe, cmd, ranges, stripped);
	}
}

fn process_pipeline(
	p: &Pipeline,
	cmd: &str,
	ranges: &mut Vec<(usize, usize)>,
	stripped: &mut Vec<String>,
) {
	let outcome = try_strip_head_tail(p, cmd, ranges, stripped);
	try_strip_2to1(p, cmd, outcome, ranges, stripped);
}

/// Outcome of the head/tail strip — the 2>&1 pass needs the effective tail.
struct HeadTailOutcome {
	stripped: bool,
	/// Index into `p.seq` of the new effective last command. Equals
	/// `seq.len()-1` when no strip fired, `seq.len()-2` when it did.
	last_idx: usize,
}

fn source_index_to_byte(cmd: &str, index: usize) -> Option<usize> {
	let mut chars_seen = 0usize;
	for (byte_idx, _) in cmd.char_indices() {
		if chars_seen == index {
			return Some(byte_idx);
		}
		chars_seen += 1;
	}
	if chars_seen == index {
		Some(cmd.len())
	} else {
		None
	}
}

fn try_strip_head_tail(
	p: &Pipeline,
	cmd: &str,
	ranges: &mut Vec<(usize, usize)>,
	stripped: &mut Vec<String>,
) -> HeadTailOutcome {
	let n = p.seq.len();
	let default = HeadTailOutcome { stripped: false, last_idx: n.saturating_sub(1) };
	if n < 2 {
		return default;
	}
	let last = &p.seq[n - 1];
	if !is_safe_head_tail(last) {
		return default;
	}
	let Some(last_loc) = last.location() else {
		return default;
	};

	// Pipeline-internal separators are always `|` or `|&` — never `||`. The
	// real parser already validated structure, so scanning backwards from the
	// start of `last` for the first `|` is unambiguous: AndOr operators
	// (`||`, `&&`) only live *between* pipelines, not inside one. We anchor
	// here rather than on `prev.location().end` because `SimpleCommand`'s
	// span under-reports when its suffix contains unlocated `IoRedirect`s
	// (e.g. the synthetic `2>&1` inserted by `|&`).
	let bytes = cmd.as_bytes();
	let Some(last_start) = source_index_to_byte(cmd, last_loc.start.index) else {
		return default;
	};
	let Some(last_end) = source_index_to_byte(cmd, last_loc.end.index) else {
		return default;
	};
	let Some(head) = cmd.get(..last_start) else {
		return default;
	};
	let Some(pipe_pos) = head.rfind('|') else {
		return default;
	};
	// Defense in depth against `||`.
	if pipe_pos > 0 && bytes[pipe_pos - 1] == b'|' {
		return default;
	}
	if pipe_pos + 1 < bytes.len() && bytes[pipe_pos + 1] == b'|' {
		return default;
	}

	// Reported text starts at the pipe and is right-trimmed. The deletion
	// range walks back through any leading whitespace so the rewrite is
	// contiguous.
	let stripped_text = cmd[pipe_pos..last_end].trim_end().to_owned();
	if stripped_text.is_empty() {
		return default;
	}
	let mut delete_start = pipe_pos;
	while delete_start > 0 && matches!(bytes[delete_start - 1], b' ' | b'\t') {
		delete_start -= 1;
	}
	ranges.push((delete_start, last_end));
	stripped.push(stripped_text);
	HeadTailOutcome { stripped: true, last_idx: n - 2 }
}

fn try_strip_2to1(
	p: &Pipeline,
	cmd: &str,
	outcome: HeadTailOutcome,
	ranges: &mut Vec<(usize, usize)>,
	stripped: &mut Vec<String>,
) {
	// `2>&1` is only redundant when no downstream pipe remains. After the
	// head/tail strip the effective tail is `outcome.last_idx`; if any other
	// command sits to its right, abort.
	if outcome.stripped {
		if outcome.last_idx != 0 {
			return;
		}
	} else if p.seq.len() != 1 {
		return;
	}

	let target = &p.seq[outcome.last_idx];
	let Command::Simple(simple) = target else {
		return;
	};
	let Some(name_word) = simple.word_or_name.as_ref() else {
		return;
	};
	if name_word.value.is_empty() {
		return;
	}
	let Some(suffix) = &simple.suffix else { return };
	if suffix.0.is_empty() {
		return;
	}

	// The last suffix item must be the `2>&1` redirect, and it must be the
	// only redirect on the command (no `> file 2>&1` or `2>&1 > file`).
	let Some(last_item) = suffix.0.last() else {
		return;
	};
	let CommandPrefixOrSuffixItem::IoRedirect(io) = last_item else {
		return;
	};
	if !is_stderr_to_stdout(io) {
		return;
	}
	for item in &suffix.0[..suffix.0.len() - 1] {
		if matches!(item, CommandPrefixOrSuffixItem::IoRedirect(_)) {
			return;
		}
	}
	if let Some(prefix) = &simple.prefix
		&& prefix
			.0
			.iter()
			.any(|item| matches!(item, CommandPrefixOrSuffixItem::IoRedirect(_)))
	{
		return;
	}

	// `IoRedirect` doesn't carry a source span, so locate the literal
	// `2>&1` by scanning forward from the rightmost located item in the
	// command — that's either `word_or_name`'s end or the last suffix item
	// whose location() is `Some`. Anything before the anchor is already
	// accounted for by the AST; the gap between the anchor and `2>&1` is
	// guaranteed to be just whitespace by the precondition that `2>&1` is
	// the last suffix item and no other redirects exist.
	let Some(name_loc) = name_word.loc.as_ref() else {
		return;
	};
	let Some(mut anchor) = source_index_to_byte(cmd, name_loc.end.index) else {
		return;
	};
	for item in &suffix.0 {
		if let Some(loc) = item.location() {
			let Some(end) = source_index_to_byte(cmd, loc.end.index) else {
				return;
			};
			anchor = anchor.max(end);
		}
	}
	let bytes = cmd.as_bytes();
	let mut pos = anchor;
	while pos < bytes.len() && matches!(bytes[pos], b' ' | b'\t') {
		pos += 1;
	}
	if !cmd.get(pos..).is_some_and(|rest| rest.starts_with("2>&1")) {
		return;
	}
	if pos == 0 {
		return;
	}
	if !matches!(bytes[pos - 1], b' ' | b'\t') {
		return;
	}
	// Walk back through any additional leading whitespace so the rewrite is
	// contiguous with neighboring tokens.
	let mut delete_start = pos - 1;
	while delete_start > 0 && matches!(bytes[delete_start - 1], b' ' | b'\t') {
		delete_start -= 1;
	}
	ranges.push((delete_start, pos + 4));
	stripped.push("2>&1".to_owned());
}

fn is_stderr_to_stdout(io: &IoRedirect) -> bool {
	let IoRedirect::File(Some(2), IoFileRedirectKind::DuplicateOutput, target) = io else {
		return false;
	};
	match target {
		IoFileRedirectTarget::Fd(1) => true,
		IoFileRedirectTarget::Duplicate(w) => w.value == "1",
		_ => false,
	}
}

fn is_safe_head_tail(c: &Command) -> bool {
	let Command::Simple(simple) = c else {
		return false;
	};
	let Some(name) = simple.word_or_name.as_ref() else {
		return false;
	};
	if name.value != "head" && name.value != "tail" {
		return false;
	}
	// Variable assignments / redirects in the prefix would change observable
	// shell behavior even with `head` removed.
	if let Some(prefix) = &simple.prefix
		&& !prefix.0.is_empty()
	{
		return false;
	}
	let Some(suffix) = &simple.suffix else {
		return true;
	};
	for item in &suffix.0 {
		let CommandPrefixOrSuffixItem::Word(w) = item else {
			return false;
		};
		if !SAFE_ARG_RE.is_match(&w.value) {
			return false;
		}
	}
	true
}

/// Token shapes that are pure "limit output" flags for `head`/`tail`:
///   `-nN`, `-n=N`, `-cN`, `-c=N`  — short flag with attached value
///   `-N`                          — BSD-style line count
///   `-n`, `-c`                    — short flag (paired value comes next)
///   `-q`, `-v`                    — quiet/verbose
///   `--lines[=N]`, `--bytes[=N]`  — long flag, optionally attached value
///   `--quiet`, `--verbose`
///   `N`                           — bare integer (the value half of `-n N`)
///
/// `+N` offsets (skip-first semantics for `tail`), `-f`/`-F`/`--follow`,
/// `--help`, and any filename token are deliberately rejected — they would
/// change semantics if their host command were removed.
static SAFE_ARG_RE: LazyLock<Regex> = LazyLock::new(|| {
	Regex::new(
		r"^(?:-[nc]=?\d+|-[nc]|-\d+|-[qv]|--lines(?:=\d+)?|--bytes(?:=\d+)?|--quiet|--verbose|\d+)$",
	)
	.expect("static safe-arg regex compiles")
});

#[cfg(test)]
mod tests {
	use super::*;

	fn run(cmd: &str) -> (String, Vec<String>) {
		let r = apply_bash_fixups(cmd);
		(r.command, r.stripped)
	}

	#[test]
	fn strips_trailing_head_tail() {
		let cases: &[(&str, &str, &[&str])] = &[
			("ls | head", "ls", &["| head"]),
			("ls | head -5", "ls", &["| head -5"]),
			("ls | head -n 5", "ls", &["| head -n 5"]),
			("ls | head -n5", "ls", &["| head -n5"]),
			("ls | head -n=5", "ls", &["| head -n=5"]),
			("ls | head -c 100", "ls", &["| head -c 100"]),
			("ls | head --lines=20", "ls", &["| head --lines=20"]),
			("ls | head --lines 20", "ls", &["| head --lines 20"]),
			("ls | head --quiet -5", "ls", &["| head --quiet -5"]),
			("ls | tail -5", "ls", &["| tail -5"]),
			("ls | tail --bytes=200", "ls", &["| tail --bytes=200"]),
			("ls|head", "ls", &["|head"]),
			("ls |  tail   -20  ", "ls", &["|  tail   -20"]),
			("git log --oneline | head -20", "git log --oneline", &["| head -20"]),
			("echo a | tr a b | head -3", "echo a | tr a b", &["| head -3"]),
			("just build |& head -5", "just build", &["|& head -5"]),
			(
				"printf '답해' && git log --oneline | head -20",
				"printf '답해' && git log --oneline",
				&["| head -20"],
			),
			(
				"curl -s -d '{\"content\":\"한국어로만 답해\"}' http://example.test | head -1",
				"curl -s -d '{\"content\":\"한국어로만 답해\"}' http://example.test",
				&["| head -1"],
			),
		];
		for (input, want_cmd, want_stripped) in cases {
			let (cmd, stripped) = run(input);
			assert_eq!(cmd, *want_cmd, "input: {input:?}");
			assert_eq!(stripped, *want_stripped, "input: {input:?}");
		}
	}

	#[test]
	fn strips_redundant_2to1() {
		let cases: &[(&str, &str, &[&str])] = &[
			("cmd 2>&1", "cmd", &["2>&1"]),
			("just build 2>&1", "just build", &["2>&1"]),
			("just build 2>&1 | tail -3", "just build", &["| tail -3", "2>&1"]),
			("cargo build 2>&1 | head -50", "cargo build", &["| head -50", "2>&1"]),
			("printf '답해' && cargo test 2>&1 | head -50", "printf '답해' && cargo test", &[
				"| head -50",
				"2>&1",
			]),
		];
		for (input, want_cmd, want_stripped) in cases {
			let (cmd, stripped) = run(input);
			assert_eq!(cmd, *want_cmd, "input: {input:?}");
			assert_eq!(stripped, *want_stripped, "input: {input:?}");
		}
	}

	#[test]
	fn strips_across_compound_commands() {
		let cases: &[(&str, &str, &[&str])] = &[
			(
				"just build 2>&1 | tail -3 && just up && sleep 4 && just healthz",
				"just build && just up && sleep 4 && just healthz",
				&["| tail -3", "2>&1"],
			),
			("cmd1 | head -5 && cmd2 && cmd3 | tail -3", "cmd1 && cmd2 && cmd3", &[
				"| head -5",
				"| tail -3",
			]),
			("echo a; cmd | head -5; echo b", "echo a; cmd; echo b", &["| head -5"]),
			("cmd | head -5 || fallback | tail -3", "cmd || fallback", &["| head -5", "| tail -3"]),
			("cmd1 | head -5 && cmd2 2>&1 | grep err", "cmd1 && cmd2 2>&1 | grep err", &["| head -5"]),
		];
		for (input, want_cmd, want_stripped) in cases {
			let (cmd, stripped) = run(input);
			assert_eq!(cmd, *want_cmd, "input: {input:?}");
			assert_eq!(stripped, *want_stripped, "input: {input:?}");
		}
	}

	#[test]
	fn preserves_semantics_bearing_pipelines() {
		let untouched: &[&str] = &[
			"tail -f /var/log/system.log",
			"tail -F file.log",
			"ls | tail -f -",
			"ls | head -5 | sort",
			"cat file | head -5 | wc -l",
			"cat file | tail -n +2",
			"cat file | tail +5",
			"ls | head -5 > /tmp/out.txt",
			"ls | head -5 2>/dev/null",
			"echo \"ls | head -5\"",
			"echo $(ls | head -5)",
			"head -5 file.txt",
			"head /etc/hosts",
			"head -5",
			"cmd 2>&1 | grep err",
			"cmd > file 2>&1",
			"cmd >& file",
			"cmd 2>&1 > file",
			"for f in *.txt; do\n  echo $f\ndone | head -5",
			"cat <<EOF | head -5\ncontent\nEOF",
			"ls\nls | head -5",
			"echo \"unterminated | head -5",
		];
		for input in untouched {
			let (cmd, stripped) = run(input);
			assert_eq!(cmd, *input, "input: {input:?}");
			assert!(stripped.is_empty(), "input: {input:?}");
		}
	}
}
