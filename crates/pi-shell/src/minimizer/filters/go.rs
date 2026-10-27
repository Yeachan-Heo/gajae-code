//! Go toolchain output filters.

use crate::minimizer::{MinimizerCtx, MinimizerOutput, primitives};

pub fn supports(program: &str, subcommand: Option<&str>) -> bool {
	match program {
		"go" => matches!(subcommand, Some("test" | "build" | "vet" | "tool")),
		"golangci-lint" => matches!(subcommand, None | Some("run")),
		_ => false,
	}
}

pub fn filter(ctx: &MinimizerCtx<'_>, input: &str, exit_code: i32) -> MinimizerOutput {
	let cleaned = primitives::strip_ansi(input);
	let text = if ctx.program == "golangci-lint" || is_go_tool_golangci_lint(ctx) {
		filter_golangci_lint(&cleaned)
	} else {
		match ctx.subcommand {
			Some("test") => filter_go_test(&cleaned, exit_code),
			Some("build") => filter_go_build(&cleaned, exit_code),
			Some("vet") => filter_go_vet(&cleaned),
			Some("tool") => input.to_string(),
			_ => compact_general(&cleaned),
		}
	};

	if text == input {
		MinimizerOutput::passthrough(input)
	} else {
		MinimizerOutput::transformed(text, input.len())
	}
}

fn is_go_tool_golangci_lint(ctx: &MinimizerCtx<'_>) -> bool {
	if ctx.program != "go" || ctx.subcommand != Some("tool") {
		return false;
	}

	let mut saw_tool = false;
	for token in ctx.command.split_whitespace() {
		if saw_tool {
			return token == "golangci-lint";
		}
		if token == "tool" {
			saw_tool = true;
		}
	}
	false
}

fn filter_go_test(input: &str, exit_code: i32) -> String {
	let mut out = String::new();
	let mut kept = 0usize;
	let mut keep_next_after_location = false;

	for line in input.lines() {
		let trimmed = line.trim();
		if trimmed.is_empty() {
			continue;
		}

		if let Some(rendered) = render_go_test_json_line(trimmed) {
			let rendered_trimmed = rendered.trim();
			let keep_line = keep_next_after_location || should_keep_go_test_line(&rendered, exit_code);
			keep_next_after_location = is_go_location_line(rendered_trimmed);
			if keep_line {
				out.push_str(&rendered);
				out.push('\n');
				kept += 1;
			}
			continue;
		}

		let keep_line = keep_next_after_location || should_keep_go_test_line(trimmed, exit_code);
		keep_next_after_location = is_go_location_line(trimmed);
		if keep_line {
			out.push_str(line.trim_end());
			out.push('\n');
			kept += 1;
		}
	}

	if kept == 0 {
		return compact_general(input);
	}

	primitives::head_tail_lines(&primitives::dedup_consecutive_lines(&out), 140, 80)
}

fn render_go_test_json_line(line: &str) -> Option<String> {
	let value: serde_json::Value = serde_json::from_str(line).ok()?;
	let action = value
		.get("Action")
		.and_then(|v| v.as_str())
		.map_or("", |value| value);
	let package = value
		.get("Package")
		.and_then(|v| v.as_str())
		.map_or("", |value| value);
	let test = value
		.get("Test")
		.and_then(|v| v.as_str())
		.map_or("", |value| value);

	if let Some(output) = value.get("Output").and_then(|v| v.as_str()) {
		let rendered = output.trim_end();
		if rendered.is_empty() {
			return None;
		}
		return Some(rendered.to_string());
	}

	match action {
		"fail" if !test.is_empty() => Some(format!("--- FAIL: {test}")),
		"fail" if !package.is_empty() => Some(format!("FAIL\t{package}")),
		"pass" if !package.is_empty() && test.is_empty() => Some(format!("ok\t{package}")),
		"skip" if !test.is_empty() => Some(format!("--- SKIP: {test}")),
		_ => None,
	}
}

fn should_keep_go_test_line(line: &str, exit_code: i32) -> bool {
	let trimmed = line.trim();
	let lower = trimmed.to_ascii_lowercase();

	if exit_code == 0 {
		return trimmed.starts_with("--- PASS")
			|| trimmed.starts_with("--- SKIP")
			|| lower.starts_with("ok\t")
			|| lower.starts_with("ok  ")
			|| lower.starts_with("?\t");
	}

	trimmed.starts_with("FAIL")
		|| trimmed.starts_with("--- FAIL")
		|| trimmed.starts_with("panic:")
		|| trimmed.starts_with("# ")
		|| is_go_location_line(trimmed)
		|| lower.contains("error:")
		|| lower.contains("fatal")
		|| lower.contains("failed")
		|| lower.contains("expected")
		|| lower.contains("actual")
		|| lower.contains("got") && lower.contains("want")
		|| lower.contains("assert")
		|| lower.contains("killed with quit")
		|| lower.starts_with("ok\t")
		|| lower.starts_with("ok  ")
		|| lower.starts_with("?\t")
		|| exit_code != 0 && (lower.contains("timeout") || lower.contains("signal"))
}

fn filter_go_build(input: &str, exit_code: i32) -> String {
	let mut out = String::new();
	let mut saw_diagnostic = false;

	for line in input.lines() {
		let trimmed = line.trim();
		if trimmed.is_empty() || is_go_noise(trimmed) {
			continue;
		}
		if trimmed.starts_with("# ")
			|| is_go_build_diagnostic(trimmed)
			|| exit_code != 0 && looks_like_go_error(trimmed)
		{
			saw_diagnostic = true;
			out.push_str(trimmed);
			out.push('\n');
		}
	}

	if !saw_diagnostic {
		return compact_general(input);
	}

	let grouped = primitives::group_by_file(&out, 24);
	primitives::head_tail_lines(&grouped, 120, 80)
}

fn filter_go_vet(input: &str) -> String {
	let mut out = String::new();
	for line in input.lines() {
		let trimmed = line.trim();
		if trimmed.is_empty() || trimmed.starts_with("# ") {
			continue;
		}
		if is_go_location_line(trimmed) || looks_like_go_error(trimmed) {
			out.push_str(trimmed);
			out.push('\n');
		}
	}

	if out.is_empty() {
		return compact_general(input);
	}

	let grouped = primitives::group_by_file(&out, 24);
	primitives::head_tail_lines(&grouped, 120, 80)
}

fn filter_golangci_lint(input: &str) -> String {
	if let Some(json_line) = input
		.lines()
		.find(|line| line.trim_start().starts_with('{'))
		&& let Some(summary) = summarize_golangci_json(json_line.trim())
	{
		return summary;
	}

	let mut out = String::new();
	for line in input.lines() {
		let trimmed = line.trim();
		if trimmed.is_empty() || is_golangci_noise(trimmed) {
			continue;
		}
		out.push_str(trimmed);
		out.push('\n');
	}

	if out.is_empty() {
		compact_general(input)
	} else {
		let grouped = primitives::group_by_file(&out, 24);
		primitives::head_tail_lines(&grouped, 160, 80)
	}
}

fn summarize_golangci_json(line: &str) -> Option<String> {
	let value: serde_json::Value = serde_json::from_str(line).ok()?;
	let issues = value.get("Issues")?.as_array()?;
	if issues.is_empty() {
		return Some("golangci-lint: no issues found\n".to_string());
	}

	let mut out = format!("golangci-lint: {} issues\n", issues.len());
	for issue in issues.iter().take(40) {
		let file = issue
			.get("Pos")
			.and_then(|pos| pos.get("Filename"))
			.and_then(|v| v.as_str())
			.map_or("<unknown>", |value| value);
		let line_no = issue
			.get("Pos")
			.and_then(|pos| pos.get("Line"))
			.and_then(|v| v.as_u64())
			.unwrap_or(0);
		let col_no = issue
			.get("Pos")
			.and_then(|pos| pos.get("Column"))
			.and_then(|v| v.as_u64())
			.unwrap_or(0);
		let linter = issue
			.get("FromLinter")
			.and_then(|v| v.as_str())
			.map_or("lint", |value| value);
		let text = issue
			.get("Text")
			.and_then(|v| v.as_str())
			.map_or("", |value| value);
		out.push_str(file);
		out.push(':');
		out.push_str(&line_no.to_string());
		out.push(':');
		out.push_str(&col_no.to_string());
		out.push_str(": ");
		out.push_str(text);
		out.push_str(" (");
		out.push_str(linter);
		out.push_str(")\n");
	}
	if issues.len() > 40 {
		out.push_str("… ");
		out.push_str(&(issues.len() - 40).to_string());
		out.push_str(" more issues\n");
	}
	Some(out)
}

fn compact_general(input: &str) -> String {
	let stripped = primitives::strip_lines(input, &[is_go_noise]);
	let deduped = primitives::dedup_consecutive_lines(&stripped);
	primitives::head_tail_lines(&deduped, 100, 60)
}

fn is_go_build_diagnostic(line: &str) -> bool {
	is_go_location_line(line)
		|| line.contains("go.mod:")
		|| line.contains("go.work:")
		|| line.contains("go.sum:")
}

fn is_go_location_line(line: &str) -> bool {
	line.contains(".go:")
}

fn looks_like_go_error(line: &str) -> bool {
	let lower = line.to_ascii_lowercase();
	lower.starts_with("undefined: ")
		|| lower.starts_with("cannot use ")
		|| lower.starts_with("cannot find package ")
		|| lower.starts_with("no required module provides package ")
		|| lower.starts_with("missing go.sum entry")
		|| lower.starts_with("found packages ")
		|| lower.starts_with("go: ")
			&& (lower.contains("error") || lower.contains("failed") || lower.contains("not found"))
		|| lower.contains("import cycle not allowed")
		|| lower.contains("build constraints exclude all go files")
}

fn is_go_noise(line: &str) -> bool {
	let lower = line.trim_start().to_ascii_lowercase();
	lower.starts_with("go: downloading ")
		|| lower.starts_with("go: finding ")
		|| lower.starts_with("go: extracting ")
		|| lower.starts_with("go: upgraded ")
		|| lower.starts_with("go: added ")
}

fn is_golangci_noise(line: &str) -> bool {
	let lower = line.to_ascii_lowercase();
	lower.starts_with("level=") && lower.contains("msg=\"[linters_context]")
		|| lower.starts_with("golangci-lint has version")
		|| lower.starts_with("running ") && lower.contains("linters")
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::minimizer::MinimizerConfig;

	#[test]
	fn keeps_go_test_failure_from_json_lines() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = MinimizerCtx {
			program:    "go",
			subcommand: Some("test"),
			command:    "go test ./...",
			config:     &cfg,
		};
		let input = r#"{"Action":"run","Package":"example.com/app","Test":"TestBad"}
{"Action":"output","Package":"example.com/app","Test":"TestBad","Output":"=== RUN   TestBad\n"}
{"Action":"output","Package":"example.com/app","Test":"TestBad","Output":"    app_test.go:12: expected 2, got 1\n"}
{"Action":"fail","Package":"example.com/app","Test":"TestBad"}
{"Action":"fail","Package":"example.com/app"}
"#;

		let out = filter(&ctx, input, 1);
		assert!(out.text.contains("app_test.go:12"));
		assert!(out.text.contains("expected 2, got 1"));
		assert!(out.text.contains("--- FAIL: TestBad"));
		assert!(!out.text.contains("=== RUN"));
	}

	#[test]
	fn keeps_go_test_json_location_followup_context() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = MinimizerCtx {
			program:    "go",
			subcommand: Some("test"),
			command:    "go test -json ./...",
			config:     &cfg,
		};
		let input = r#"{"Action":"output","Package":"example.com/app","Test":"TestBad","Output":"    app_test.go:42:\n"}
	{"Action":"output","Package":"example.com/app","Test":"TestBad","Output":"        important table diff without keywords\n"}
	{"Action":"output","Package":"example.com/app","Output":"Test killed with quit: ran too long\n"}
	{"Action":"fail","Package":"example.com/app","Test":"TestBad"}
	"#;

		let out = filter(&ctx, input, 1);
		assert!(out.text.contains("app_test.go:42:"));
		assert!(out.text.contains("important table diff without keywords"));
		assert!(out.text.contains("Test killed with quit"));
	}

	#[test]
	fn go_test_verbose_success_drops_run_and_ginkgo_success_noise() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = MinimizerCtx {
			program:    "go",
			subcommand: Some("test"),
			command:    "go test ./... -v",
			config:     &cfg,
		};
		let input = "=== RUN   TestControllers\nRunning Suite: Controller Suite\nSUCCESS! -- 1 \
		             Passed | 0 Failed | 0 Pending\n--- PASS: TestControllers (6.04s)\nPASS\nok  \
		             kubecraft.ai/.../controller  6.610s\n=== RUN   TestNewClient\n--- PASS: \
		             TestNewClient (0.00s)\nPASS\nok  kubecraft.ai/.../llm  0.776s\n";
		let out = filter(&ctx, input, 0);
		assert!(out.text.contains("--- PASS: TestControllers (6.04s)"));
		assert!(out.text.contains("ok  kubecraft.ai/.../controller  6.610s"));
		assert!(out.text.contains("--- PASS: TestNewClient (0.00s)"));
		assert!(!out.text.contains("=== RUN"));
		assert!(!out.text.contains("SUCCESS!"));
	}

	#[test]
	fn summarizes_golangci_json_issues() {
		let input = r#"{"Issues":[{"FromLinter":"govet","Text":"unreachable code","Pos":{"Filename":"main.go","Line":7,"Column":2}}]}"#;
		let out = filter_golangci_lint(input);
		assert!(out.contains("golangci-lint: 1 issues"));
		assert!(out.contains("main.go:7:2: unreachable code (govet)"));
	}

	#[test]
	fn go_tool_golangci_lint_is_filtered() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = MinimizerCtx {
			program:    "go",
			subcommand: Some("tool"),
			command:    "go tool golangci-lint run ./...",
			config:     &cfg,
		};
		let input = r#"{"Issues":[{"FromLinter":"govet","Text":"bad","Pos":{"Filename":"main.go","Line":7,"Column":2}}]}"#;
		let out = filter(&ctx, input, 1);
		assert!(out.changed);
		assert!(out.text.contains("main.go:7:2: bad (govet)"));
	}

	#[test]
	fn unknown_go_tool_is_passthrough() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = MinimizerCtx {
			program:    "go",
			subcommand: Some("tool"),
			command:    "go tool pprof profile.out",
			config:     &cfg,
		};
		let input = "Type: cpu\nShowing nodes accounting for 10ms\ngo: downloading noise\n";
		let out = filter(&ctx, input, 0);
		assert_eq!(out.text, input);
		assert!(!out.changed);
	}
}
