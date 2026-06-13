//! Structural source summaries powered by tree-sitter.

use std::{collections::BTreeSet, path::Path};

use anyhow::{Result, anyhow};
use ast_grep_core::tree_sitter::LanguageExt;
use serde::{Deserialize, Serialize};
use tree_sitter::{Node, Parser};

use crate::{language::SupportLang, ops};

const DEFAULT_MIN_BODY_LINES: u32 = 4;
const DEFAULT_MIN_COMMENT_LINES: u32 = 6;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SummaryOptions {
	/// Source code to summarize.
	pub code:              String,
	/// Language alias (e.g. "rust", "typescript") used before path inference.
	pub lang:              Option<String>,
	/// File path used to infer language by extension when `lang` is omitted.
	pub path:              Option<String>,
	/// Minimum total node lines before eliding a body/literal node.
	pub min_body_lines:    Option<u32>,
	/// Minimum total comment lines before eliding a multiline block comment.
	pub min_comment_lines: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SummarySegment {
	/// "kept" or "elided".
	pub kind:       String,
	/// 1-based inclusive start line.
	pub start_line: u32,
	/// 1-based inclusive end line.
	pub end_line:   u32,
	/// Verbatim text for kept segments; absent for elided segments.
	pub text:       Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SummaryResult {
	/// Canonical language name when parsing succeeded.
	pub language:    Option<String>,
	/// True when tree-sitter parsed the source without syntax errors.
	pub parsed:      bool,
	/// True when at least one elision span was emitted.
	pub elided:      bool,
	/// Total source lines.
	pub total_lines: u32,
	/// Kept/elided segments in source order.
	pub segments:    Vec<SummarySegment>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct LineSpan {
	start: u32,
	end:   u32,
}

pub fn summarize_code(options: SummaryOptions) -> Result<SummaryResult> {
	let source = options.code;
	let total_lines = count_lines(&source);
	if source.is_empty() {
		return Ok(unparsed_result(source, total_lines));
	}

	let Some(language) = resolve_language(options.lang.as_deref(), options.path.as_deref())? else {
		return Ok(unparsed_result(source, total_lines));
	};

	let mut parser = Parser::new();
	parser
		.set_language(&language.get_ts_language())
		.map_err(|err| anyhow!("Failed to load tree-sitter language: {err}"))?;
	let Some(tree) = parser.parse(&source, None) else {
		return Ok(unparsed_result(source, total_lines));
	};
	let root = tree.root_node();
	if root.has_error() {
		return Ok(unparsed_result(source, total_lines));
	}

	let min_body_lines = options
		.min_body_lines
		.unwrap_or(DEFAULT_MIN_BODY_LINES)
		.max(2);
	let min_comment_lines = options
		.min_comment_lines
		.unwrap_or(DEFAULT_MIN_COMMENT_LINES)
		.max(4);
	let mut spans = Vec::new();
	collect_elisions(root, language, min_body_lines, min_comment_lines, &mut spans);
	let spans = normalize_spans(spans, total_lines);
	let segments = build_segments(&source, total_lines, &spans);

	Ok(SummaryResult {
		language: Some(language.canonical_name().to_string()),
		parsed: true,
		elided: !spans.is_empty(),
		total_lines,
		segments,
	})
}

fn resolve_language(lang: Option<&str>, path: Option<&str>) -> Result<Option<SupportLang>> {
	if let Some(lang) = lang.map(str::trim).filter(|lang| !lang.is_empty()) {
		return ops::resolve_supported_lang(lang).map(Some);
	}
	let Some(path) = path.map(str::trim).filter(|path| !path.is_empty()) else {
		return Ok(None);
	};
	Ok(SupportLang::from_path(Path::new(path)))
}

fn unparsed_result(source: String, total_lines: u32) -> SummaryResult {
	let segments = if source.is_empty() {
		Vec::new()
	} else {
		vec![SummarySegment {
			kind:       "kept".to_string(),
			start_line: 1,
			end_line:   total_lines,
			text:       Some(source),
		}]
	};
	SummaryResult { language: None, parsed: false, elided: false, total_lines, segments }
}

fn count_lines(source: &str) -> u32 {
	if source.is_empty() {
		0
	} else {
		source.lines().count().max(1).min(u32::MAX as usize) as u32
	}
}

fn collect_elisions(
	node: Node<'_>,
	language: SupportLang,
	min_body_lines: u32,
	min_comment_lines: u32,
	spans: &mut Vec<LineSpan>,
) {
	let total_lines = node_line_count(node);
	if is_comment_kind(language, node.kind()) {
		if total_lines >= min_comment_lines {
			let start_line = node_start_line(node) + 2;
			let end_line = node_end_line(node).saturating_sub(1);
			if start_line <= end_line {
				spans.push(LineSpan { start: start_line, end: end_line });
			}
		}
		return;
	}

	if is_elidable_kind(language, node.kind()) && total_lines >= min_body_lines {
		let start_line = node_start_line(node) + 1;
		let end_line = node_end_line(node).saturating_sub(1);
		if start_line <= end_line {
			spans.push(LineSpan { start: start_line, end: end_line });
			return;
		}
	}

	// Detect consecutive runs of groupable siblings (e.g. import statements).
	// When the run's total line span meets `min_body_lines`, elide the lines
	// strictly between the first and last sibling's content, leaving the
	// boundary statements visible.
	let child_count = node.child_count();
	let mut run_first: Option<Node<'_>> = None;
	let mut run_last: Option<Node<'_>> = None;
	let mut run_count: u32 = 0;
	for index in 0..child_count {
		let Some(child) = node.child(index) else {
			continue;
		};
		if is_groupable_kind(language, child.kind()) {
			if run_first.is_none() {
				run_first = Some(child);
			}
			run_last = Some(child);
			run_count += 1;
		} else {
			flush_groupable_run(run_first, run_last, run_count, min_body_lines, spans);
			run_first = None;
			run_last = None;
			run_count = 0;
		}
	}
	flush_groupable_run(run_first, run_last, run_count, min_body_lines, spans);

	for index in 0..child_count {
		if let Some(child) = node.child(index) {
			collect_elisions(child, language, min_body_lines, min_comment_lines, spans);
		}
	}
}

fn flush_groupable_run(
	first: Option<Node<'_>>,
	last: Option<Node<'_>>,
	count: u32,
	min_body_lines: u32,
	spans: &mut Vec<LineSpan>,
) {
	if count < 2 {
		return;
	}
	let (Some(first), Some(last)) = (first, last) else {
		return;
	};
	let first_start = node_start_line(first);
	let last_start = node_start_line(last);
	let last_end = node_end_line(last);
	let span_lines = last_end.saturating_sub(first_start).saturating_add(1);
	if span_lines < min_body_lines {
		return;
	}
	// Use the line of the first node's last visible content as the lower bound
	// (some grammars include trailing newlines in the node range, which would
	// otherwise place `end_line` on the next sibling's first line).
	let first_content_end = node_content_end_line(first).min(last_start.saturating_sub(1));
	let start = first_content_end.saturating_add(1);
	let end = last_start.saturating_sub(1);
	if start <= end {
		spans.push(LineSpan { start, end });
	}
}

fn node_start_line(node: Node<'_>) -> u32 {
	node
		.start_position()
		.row
		.saturating_add(1)
		.min(u32::MAX as usize) as u32
}

fn node_end_line(node: Node<'_>) -> u32 {
	node
		.end_position()
		.row
		.saturating_add(1)
		.min(u32::MAX as usize) as u32
}

/// Last source line containing a content byte from `node`.
///
/// Tree-sitter reports `end_position` as the position one past the last byte.
/// When that byte is a newline, the resulting position lands at column 0 of
/// the next row, which makes the naive `row + 1` answer one greater than the
/// row of the last visible content. This helper subtracts that off.
fn node_content_end_line(node: Node<'_>) -> u32 {
	let pos = node.end_position();
	let row = if pos.column == 0 && pos.row > 0 {
		pos.row - 1
	} else {
		pos.row
	};
	row.saturating_add(1).min(u32::MAX as usize) as u32
}

fn node_line_count(node: Node<'_>) -> u32 {
	node_end_line(node)
		.saturating_sub(node_start_line(node))
		.saturating_add(1)
}

fn is_comment_kind(language: SupportLang, kind: &str) -> bool {
	match language {
		SupportLang::TypeScript | SupportLang::Tsx | SupportLang::JavaScript => kind == "comment",
		SupportLang::Rust => kind == "block_comment",
		SupportLang::Python => kind == "comment",
		SupportLang::Go => kind == "comment",
		SupportLang::Java => kind == "block_comment",
		SupportLang::C | SupportLang::Cpp => kind == "comment",
		#[cfg(feature = "full-langs")]
		SupportLang::ObjC => kind == "comment",
		SupportLang::CSharp => kind == "comment",
		SupportLang::Ruby => kind == "comment",
		SupportLang::Php => kind == "comment",
		#[cfg(feature = "full-langs")]
		SupportLang::Swift => kind == "comment",
		#[cfg(feature = "full-langs")]
		SupportLang::Kotlin => kind == "block_comment",
		#[cfg(feature = "full-langs")]
		SupportLang::Scala => kind == "block_comment",
		#[cfg(feature = "full-langs")]
		SupportLang::Lua => kind == "comment",
		_ => false,
	}
}

fn is_elidable_kind(language: SupportLang, kind: &str) -> bool {
	match language {
		SupportLang::TypeScript | SupportLang::Tsx | SupportLang::JavaScript => matches!(
			kind,
			"statement_block"
				| "function_body"
				| "object"
				| "array"
				| "template_string"
				| "class_body"
				| "interface_body"
				| "enum_body"
				| "object_type"
				| "switch_body"
				| "jsx_element"
				| "jsx_self_closing_element"
		),
		SupportLang::Rust => matches!(
			kind,
			"block"
				| "array_expression"
				| "tuple_expression"
				| "struct_expression"
				| "match_block"
				| "raw_string_literal"
				| "declaration_list"
				| "field_declaration_list"
				| "ordered_field_declaration_list"
				| "enum_variant_list"
				| "where_clause"
				| "use_list"
				| "macro_definition"
				| "token_tree"
		),
		SupportLang::Python => matches!(
			kind,
			"block"
				| "dictionary"
				| "list" | "set"
				| "string"
				| "tuple"
				| "argument_list"
				| "parameters"
				| "parenthesized_expression"
				| "list_comprehension"
				| "set_comprehension"
				| "dictionary_comprehension"
				| "generator_expression"
				| "import_from_statement"
				| "subscript"
		),
		SupportLang::Go => matches!(
			kind,
			"block"
				| "composite_literal"
				| "interpreted_string_literal"
				| "raw_string_literal"
				| "import_spec_list"
				| "const_declaration"
				| "var_declaration"
				| "field_declaration_list"
				| "interface_type"
				| "expression_switch_statement"
				| "type_switch_statement"
				| "select_statement"
		),
		SupportLang::Java => matches!(
			kind,
			"block"
				| "array_initializer"
				| "class_body"
				| "interface_body"
				| "enum_body"
				| "annotation_type_body"
				| "constructor_body"
				| "switch_block"
				| "string_literal"
		),
		SupportLang::C => matches!(
			kind,
			"compound_statement"
				| "initializer_list"
				| "string_literal"
				| "field_declaration_list"
				| "enumerator_list"
				| "concatenated_string"
		),
		SupportLang::Cpp => matches!(
			kind,
			"compound_statement"
				| "initializer_list"
				| "string_literal"
				| "field_declaration_list"
				| "enumerator_list"
				| "concatenated_string"
				| "declaration_list"
				| "raw_string_literal"
				| "requires_clause"
		),
		#[cfg(feature = "full-langs")]
		SupportLang::ObjC => matches!(
			kind,
			"compound_statement"
				| "initializer_list"
				| "string_literal"
				| "protocol_declaration"
				| "class_interface"
				| "class_implementation"
				| "instance_variables"
				| "array_literal"
				| "dictionary_literal"
		),
		SupportLang::CSharp => matches!(
			kind,
			"block"
				| "initializer_expression"
				| "array_initializer_expression"
				| "declaration_list"
				| "enum_member_declaration_list"
				| "switch_expression"
				| "raw_string_literal"
				| "interpolated_string_expression"
		),
		SupportLang::Ruby => matches!(
			kind,
			"body_statement"
				| "method"
				| "do_block"
				| "array"
				| "hash" | "block"
				| "case" | "heredoc_body"
		),
		SupportLang::Php => matches!(
			kind,
			"compound_statement"
				| "array_creation_expression"
				| "declaration_list"
				| "enum_declaration_list"
				| "match_block"
				| "heredoc"
				| "nowdoc"
		),
		#[cfg(feature = "full-langs")]
		SupportLang::Swift => matches!(
			kind,
			"function_body"
				| "array_literal"
				| "dictionary_literal"
				| "multi_line_string_literal"
				| "class_body"
				| "protocol_body"
				| "enum_class_body"
				| "computed_property"
				| "lambda_literal"
		),
		#[cfg(feature = "full-langs")]
		SupportLang::Kotlin => matches!(
			kind,
			"function_body"
				| "collection_literal"
				| "multi_line_string_literal"
				| "class_body"
				| "enum_class_body"
				| "when_expression"
				| "import_list"
		),
		#[cfg(feature = "full-langs")]
		SupportLang::Scala => matches!(
			kind,
			"block"
				| "collection_literal"
				| "template_body"
				| "enum_body"
				| "match_expression"
				| "for_expression"
				| "string"
		),
		#[cfg(feature = "full-langs")]
		SupportLang::Lua => matches!(kind, "block" | "table_constructor" | "string"),
		#[cfg(feature = "full-langs")]
		SupportLang::Perl => {
			matches!(kind, "block" | "list_expression" | "heredoc_content" | "regexp_content")
		},
		#[cfg(feature = "full-langs")]
		SupportLang::Dart => matches!(
			kind,
			"block"
				| "function_expression_body"
				| "class_body"
				| "enum_body"
				| "extension_body"
				| "mixin_body"
				| "list_literal"
				| "set_or_map_literal"
				| "string_literal"
		),
		SupportLang::Bash => matches!(
			kind,
			"compound_statement"
				| "if_statement"
				| "case_statement"
				| "do_group"
				| "subshell"
				| "array"
				| "heredoc_body"
		),
		#[cfg(feature = "full-langs")]
		SupportLang::Powershell => matches!(
			kind,
			"script_block"
				| "statement_block"
				| "class_statement"
				| "param_block"
				| "hash_literal_expression"
				| "array_expression"
				| "expandable_here_string_literal"
				| "verbatim_here_string_characters"
		),
		#[cfg(feature = "full-langs")]
		SupportLang::Haskell => matches!(
			kind,
			"imports"
				| "data_type"
				| "class"
				| "instance"
				| "function"
				| "do" | "case"
				| "let" | "local_binds"
				| "list" | "tuple"
		),
		#[cfg(feature = "full-langs")]
		SupportLang::Ocaml => matches!(
			kind,
			"structure"
				| "signature"
				| "variant_declaration"
				| "record_declaration"
				| "match_expression"
				| "match_case"
				| "let_expression"
				| "value_definition"
				| "list_expression"
		),
		#[cfg(feature = "full-langs")]
		SupportLang::Elixir => matches!(kind, "do_block" | "list" | "map" | "string" | "sigil"),
		#[cfg(feature = "full-langs")]
		SupportLang::Erlang => matches!(
			kind,
			"fun_decl"
				| "case_expr"
				| "if_expr"
				| "receive_expr"
				| "record_decl"
				| "list" | "map_expr"
				| "tuple"
		),
		#[cfg(feature = "full-langs")]
		SupportLang::Clojure => {
			matches!(kind, "list_lit" | "map_lit" | "vec_lit" | "set_lit" | "str_lit")
		},
		#[cfg(feature = "full-langs")]
		SupportLang::Solidity => {
			matches!(kind, "contract_body" | "function_body" | "struct_body" | "enum_body")
		},
		#[cfg(feature = "full-langs")]
		SupportLang::Sql => matches!(kind, "column_definitions" | "case"),
		#[cfg(feature = "full-langs")]
		SupportLang::Zig => matches!(kind, "Block" | "ContainerDecl" | "InitList"),
		#[cfg(feature = "full-langs")]
		SupportLang::Odin => matches!(
			kind,
			"block" | "struct_declaration" | "enum_declaration" | "union_declaration" | "struct"
		),
		#[cfg(feature = "full-langs")]
		SupportLang::Verilog => matches!(
			kind,
			"module_declaration"
				| "seq_block"
				| "case_statement"
				| "function_declaration"
				| "task_declaration"
				| "list_of_port_declarations"
		),
		#[cfg(feature = "full-langs")]
		SupportLang::Tlaplus => matches!(kind, "module" | "theorem" | "let_in"),
		#[cfg(feature = "full-langs")]
		SupportLang::Nix => matches!(
			kind,
			"attrset_expression" | "list_expression" | "let_expression" | "indented_string_expression"
		),
		#[cfg(feature = "full-langs")]
		SupportLang::Proto => matches!(kind, "message_body" | "enum_body" | "oneof" | "service"),
		#[cfg(feature = "full-langs")]
		SupportLang::Julia => matches!(
			kind,
			"function_definition"
				| "struct_definition"
				| "module_definition"
				| "do_clause"
				| "vector_expression"
				| "string_literal"
		),
		#[cfg(feature = "full-langs")]
		SupportLang::R => matches!(kind, "braced_expression" | "call" | "string"),
		#[cfg(feature = "full-langs")]
		SupportLang::Starlark => matches!(kind, "block" | "list" | "dictionary" | "string"),
		#[cfg(feature = "full-langs")]
		SupportLang::Astro => {
			matches!(kind, "frontmatter_js_block" | "script_element" | "style_element" | "element")
		},
		#[cfg(feature = "full-langs")]
		SupportLang::Vue => {
			matches!(kind, "template_element" | "script_element" | "style_element" | "element")
		},
		#[cfg(feature = "full-langs")]
		SupportLang::Svelte => matches!(kind, "script_element" | "style_element" | "element"),
		SupportLang::Html => matches!(kind, "element" | "script_element" | "style_element"),
		SupportLang::Css => matches!(kind, "block" | "keyframe_block_list"),
		SupportLang::Json => matches!(kind, "object" | "array"),
		#[cfg(feature = "full-langs")]
		SupportLang::Xml => kind == "element",
		SupportLang::Markdown => matches!(kind, "fenced_code_block" | "pipe_table" | "list"),
		#[cfg(feature = "full-langs")]
		SupportLang::Graphql => matches!(
			kind,
			"fields_definition"
				| "enum_values_definition"
				| "input_fields_definition"
				| "schema_definition"
		),
		#[cfg(feature = "full-langs")]
		SupportLang::Hcl => matches!(kind, "body" | "object"),
		#[cfg(feature = "full-langs")]
		SupportLang::Dockerfile => kind == "shell_command",
		#[cfg(feature = "full-langs")]
		SupportLang::Cmake => matches!(kind, "argument_list" | "body"),
		#[cfg(feature = "full-langs")]
		SupportLang::Make => kind == "recipe",
		#[cfg(feature = "full-langs")]
		SupportLang::Just => kind == "recipe_body",
		// Skip: data formats with no closing-token anchor (Yaml mappings,
		// Toml tables, Ini sections), the diff format whose informational
		// content IS the lines inside hunks, and the leaf-token-only Regex
		// grammar. Eliding any of these deletes the only content worth
		// reading.
		SupportLang::Yaml | SupportLang::Toml => false,
		#[cfg(feature = "full-langs")]
		SupportLang::Ini | SupportLang::Diff | SupportLang::Regex => false,
	}
}

fn is_groupable_kind(language: SupportLang, kind: &str) -> bool {
	match language {
		SupportLang::TypeScript | SupportLang::Tsx | SupportLang::JavaScript => {
			kind == "import_statement"
		},
		SupportLang::Rust => matches!(kind, "use_declaration" | "extern_crate_declaration"),
		SupportLang::Python => {
			matches!(kind, "import_statement" | "import_from_statement" | "future_import_statement")
		},
		SupportLang::Go => kind == "import_declaration",
		SupportLang::Java => kind == "import_declaration",
		SupportLang::C | SupportLang::Cpp => kind == "preproc_include",
		#[cfg(feature = "full-langs")]
		SupportLang::ObjC => matches!(kind, "preproc_include" | "import_declaration"),
		SupportLang::CSharp => kind == "using_directive",
		SupportLang::Php => kind == "namespace_use_declaration",
		#[cfg(feature = "full-langs")]
		SupportLang::Swift => kind == "import_declaration",
		#[cfg(feature = "full-langs")]
		SupportLang::Scala => matches!(kind, "import_declaration" | "import"),
		#[cfg(feature = "full-langs")]
		SupportLang::Dart => kind == "import_or_export",
		#[cfg(feature = "full-langs")]
		SupportLang::Ocaml => kind == "open_module",
		#[cfg(feature = "full-langs")]
		SupportLang::Solidity => kind == "import_directive",
		#[cfg(feature = "full-langs")]
		SupportLang::Julia => matches!(kind, "import_statement" | "using_statement"),
		#[cfg(feature = "full-langs")]
		SupportLang::Proto => kind == "import",
		#[cfg(feature = "full-langs")]
		SupportLang::Perl => kind == "use_statement",
		// Languages where imports either have no run pattern, are wrapped in a
		// single AST node already covered by `is_elidable_kind` (Kotlin's
		// `import_list`, Haskell's `imports`), or live inside a too-generic
		// container (Powershell `statement_list`).
		SupportLang::Ruby
		| SupportLang::Bash
		| SupportLang::Html
		| SupportLang::Css
		| SupportLang::Json
		| SupportLang::Markdown
		| SupportLang::Yaml
		| SupportLang::Toml => false,
		#[cfg(feature = "full-langs")]
		SupportLang::Kotlin
		| SupportLang::Haskell
		| SupportLang::Powershell
		| SupportLang::Lua
		| SupportLang::Elixir
		| SupportLang::Erlang
		| SupportLang::Clojure
		| SupportLang::Sql
		| SupportLang::Zig
		| SupportLang::Odin
		| SupportLang::Verilog
		| SupportLang::Tlaplus
		| SupportLang::Nix
		| SupportLang::R
		| SupportLang::Starlark
		| SupportLang::Astro
		| SupportLang::Vue
		| SupportLang::Svelte
		| SupportLang::Xml
		| SupportLang::Graphql
		| SupportLang::Hcl
		| SupportLang::Dockerfile
		| SupportLang::Cmake
		| SupportLang::Make
		| SupportLang::Just
		| SupportLang::Ini
		| SupportLang::Diff
		| SupportLang::Regex => false,
	}
}

fn normalize_spans(mut spans: Vec<LineSpan>, total_lines: u32) -> Vec<LineSpan> {
	if total_lines == 0 {
		return Vec::new();
	}
	spans.retain(|span| span.start <= span.end && span.start <= total_lines);
	for span in &mut spans {
		span.end = span.end.min(total_lines);
	}
	spans.sort_by_key(|span| (span.start, span.end));
	let mut merged: Vec<LineSpan> = Vec::new();
	for span in spans {
		if let Some(last) = merged.last_mut()
			&& span.start <= last.end.saturating_add(1)
		{
			last.end = last.end.max(span.end);
			continue;
		}
		merged.push(span);
	}
	merged
}

fn build_segments(source: &str, total_lines: u32, spans: &[LineSpan]) -> Vec<SummarySegment> {
	if total_lines == 0 {
		return Vec::new();
	}
	let source_lines: Vec<&str> = source.lines().collect();
	let elided_lines = spans
		.iter()
		.flat_map(|span| span.start..=span.end)
		.collect::<BTreeSet<_>>();
	let mut segments = Vec::new();
	let mut current_kind: Option<&str> = None;
	let mut current_start = 1;
	let mut current_lines: Vec<&str> = Vec::new();

	for line_number in 1..=total_lines {
		let is_elided = elided_lines.contains(&line_number);
		let kind = if is_elided { "elided" } else { "kept" };
		if current_kind.is_some_and(|existing| existing != kind) {
			push_segment(
				&mut segments,
				current_kind.expect("kind set"),
				current_start,
				line_number - 1,
				&current_lines,
			);
			current_start = line_number;
			current_lines.clear();
		}
		current_kind = Some(kind);
		if !is_elided {
			let index = line_number.saturating_sub(1) as usize;
			current_lines.push(source_lines.get(index).copied().unwrap_or_default());
		}
	}

	if let Some(kind) = current_kind {
		push_segment(&mut segments, kind, current_start, total_lines, &current_lines);
	}
	segments
}

fn push_segment(
	segments: &mut Vec<SummarySegment>,
	kind: &str,
	start_line: u32,
	end_line: u32,
	lines: &[&str],
) {
	segments.push(SummarySegment {
		kind: kind.to_string(),
		start_line,
		end_line,
		text: (kind == "kept").then(|| lines.join("\n")),
	});
}

#[cfg(test)]
mod tests {
	use super::*;

	fn summarize(code: &str, path: &str) -> SummaryResult {
		summarize_code(SummaryOptions {
			code:              code.to_string(),
			lang:              None,
			path:              Some(path.to_string()),
			min_body_lines:    None,
			min_comment_lines: None,
		})
		.expect("summary succeeds")
	}

	fn segment_kinds(result: &SummaryResult) -> Vec<&str> {
		result
			.segments
			.iter()
			.map(|segment| segment.kind.as_str())
			.collect()
	}

	#[test]
	fn summarizes_typescript_function_body() {
		let result = summarize(
			"export function greet(name: string): string {\n\tconst clean = name.trim();\n\tconst \
			 label = clean || 'world';\n\treturn `hello ${label}`;\n}\n",
			"fixture.ts",
		);

		assert!(result.parsed);
		assert!(result.elided);
		assert_eq!(result.language.as_deref(), Some("typescript"));
		assert_eq!(segment_kinds(&result), vec!["kept", "elided", "kept"]);
		assert_eq!(
			result.segments[0].text.as_deref(),
			Some("export function greet(name: string): string {")
		);
		assert_eq!(result.segments[1].start_line, 2);
		assert_eq!(result.segments[1].end_line, 4);
		assert_eq!(result.segments[2].text.as_deref(), Some("}"));
	}

	#[test]
	fn summarizes_rust_method_body_but_keeps_impl_boundaries() {
		let result = summarize(
			"struct Greeter;\n\nimpl Greeter {\n\tfn greet(&self) -> String {\n\t\tlet name = \
			 \"world\";\n\t\tlet label = name.to_uppercase();\n\t\tformat!(\"hello \
			 {label}\")\n\t}\n}\n",
			"fixture.rs",
		);

		assert!(result.parsed);
		assert!(result.elided);
		let rendered = result
			.segments
			.iter()
			.map(|segment| segment.text.clone().unwrap_or_else(|| "...".to_string()))
			.collect::<Vec<_>>()
			.join("\n");
		assert!(rendered.contains("impl Greeter {\n...\n}"));
	}

	#[test]
	fn summarizes_python_function_body() {
		let result =
			summarize(
				"class Greeter:\n    def greet(self, name: str) -> str:\n        clean = \
				 name.strip()\n        label = clean or 'world'\n        return f'hello {label}'\n",
				"fixture.py",
			);

		assert!(result.parsed);
		assert!(result.elided);
		assert_eq!(segment_kinds(&result), vec!["kept", "elided", "kept"]);
		assert!(
			result.segments[0]
				.text
				.as_deref()
				.unwrap_or_default()
				.contains("def greet")
		);
		assert!(
			result.segments[2]
				.text
				.as_deref()
				.unwrap_or_default()
				.contains("return")
		);
	}

	#[test]
	fn min_body_lines_controls_short_body_elision() {
		let code = "function small() {\n\treturn 1;\n}\n";
		let default_result = summarize(code, "fixture.ts");
		assert!(default_result.parsed);
		assert!(!default_result.elided);

		let override_result = summarize_code(SummaryOptions {
			code:              code.to_string(),
			lang:              Some("typescript".to_string()),
			path:              None,
			min_body_lines:    Some(3),
			min_comment_lines: None,
		})
		.expect("summary succeeds");
		assert!(override_result.elided);
	}

	#[test]
	fn parse_failure_falls_back_to_unparsed() {
		let result = summarize("export function broken( {\n", "fixture.ts");
		assert!(!result.parsed);
		assert!(!result.elided);
		assert_eq!(result.segments.len(), 1);
	}

	#[test]
	fn unsupported_language_is_unparsed() {
		let result = summarize("plain text\nwith lines\n", "fixture.txt");
		assert!(!result.parsed);
		assert_eq!(result.segments[0].text.as_deref(), Some("plain text\nwith lines\n"));
	}

	#[test]
	fn summarizes_typescript_interface_body() {
		let result = summarize(
			"export interface Args {\n\tcwd?: string;\n\tprovider?: string;\n\tmodel?: \
			 string;\n\tapiKey?: string;\n}\n",
			"fixture.ts",
		);

		assert!(result.parsed);
		assert!(result.elided);
		assert_eq!(segment_kinds(&result), vec!["kept", "elided", "kept"]);
		assert_eq!(result.segments[0].text.as_deref(), Some("export interface Args {"));
		assert_eq!(result.segments[2].text.as_deref(), Some("}"));
	}

	#[test]
	fn summarizes_typescript_class_body() {
		let result = summarize(
			"export class Greeter {\n\tname: string = \"world\";\n\tlength(): number { return \
			 this.name.length; }\n\tgreet(): string { return this.name; }\n\tshout(): string { \
			 return this.name.toUpperCase(); }\n}\n",
			"fixture.ts",
		);

		assert!(result.parsed);
		assert!(result.elided);
		assert_eq!(segment_kinds(&result), vec!["kept", "elided", "kept"]);
		assert!(
			result.segments[0]
				.text
				.as_deref()
				.unwrap_or_default()
				.contains("class Greeter")
		);
		assert_eq!(result.segments[2].text.as_deref(), Some("}"));
	}

	#[test]
	fn summarizes_rust_trait_declaration_list() {
		let result = summarize(
			"pub trait Greeter {\n\tfn greet(&self) -> String;\n\tfn length(&self) -> usize;\n\tfn \
			 shout(&self) -> String;\n\tfn whisper(&self) -> String;\n}\n",
			"fixture.rs",
		);

		assert!(result.parsed);
		assert!(result.elided);
		assert_eq!(segment_kinds(&result), vec!["kept", "elided", "kept"]);
		assert_eq!(result.segments[0].text.as_deref(), Some("pub trait Greeter {"));
		assert_eq!(result.segments[2].text.as_deref(), Some("}"));
	}

	#[test]
	fn summarizes_java_class_body() {
		let result = summarize(
			"public class Greeter {\n\tprivate String name;\n\tpublic Greeter(String n) { this.name \
			 = n; }\n\tpublic String greet() { return name; }\n\tpublic int length() { return \
			 name.length(); }\n}\n",
			"fixture.java",
		);

		assert!(result.parsed);
		assert!(result.elided);
		assert_eq!(segment_kinds(&result), vec!["kept", "elided", "kept"]);
		assert!(
			result.segments[0]
				.text
				.as_deref()
				.unwrap_or_default()
				.contains("class Greeter")
		);
		assert_eq!(result.segments[2].text.as_deref(), Some("}"));
	}

	#[test]
	fn summarizes_typescript_import_run() {
		let code = "import a from \"a\";\nimport b from \"b\";\nimport c from \"c\";\nimport d from \
		            \"d\";\nimport e from \"e\";\nimport f from \"f\";\n\nexport function main() \
		            {}\n";
		let result = summarize(code, "fixture.ts");

		assert!(result.parsed);
		assert!(result.elided);
		// Lines 2-5 are between the first and last imports and must be elided.
		let elided = result
			.segments
			.iter()
			.find(|seg| seg.kind == "elided")
			.expect("elided segment");
		assert_eq!(elided.start_line, 2);
		assert_eq!(elided.end_line, 5);
		// First import line is kept.
		assert!(
			result.segments[0]
				.text
				.as_deref()
				.unwrap_or_default()
				.starts_with("import a from")
		);
	}

	#[test]
	fn does_not_elide_short_typescript_import_run() {
		// 3 imports → total span 3 lines, below default min_body_lines (4).
		let result = summarize(
			"import a from \"a\";\nimport b from \"b\";\nimport c from \"c\";\n",
			"fixture.ts",
		);
		assert!(result.parsed);
		assert!(!result.elided);
	}

	#[test]
	fn summarizes_python_import_run() {
		let code = "import os\nimport sys\nfrom typing import List\nfrom pathlib import \
		            Path\nimport json\nimport re\n\nprint('go')\n";
		let result = summarize(code, "fixture.py");

		assert!(result.parsed);
		assert!(result.elided);
		let elided = result
			.segments
			.iter()
			.find(|seg| seg.kind == "elided")
			.expect("elided segment");
		assert_eq!(elided.start_line, 2);
		assert_eq!(elided.end_line, 5);
	}

	#[test]
	fn summarizes_c_preproc_include_run() {
		// C grammar puts each #include's `end_position` at column 0 of the next
		// row (the trailing `\n`). Without `node_content_end_line`, the run
		// elision would emit a span that starts past the second include and
		// only collapse the third — verify the boundary statements stay
		// visible and the middle is collapsed.
		let code = "#include <stdio.h>\n#include \"a.h\"\n#include \"b.h\"\n#include \
		            \"c.h\"\n#include <string.h>\nint main(void) { return 0; }\n";
		let result = summarize(code, "fixture.c");

		assert!(result.parsed);
		assert!(result.elided);
		let elided = result
			.segments
			.iter()
			.find(|seg| seg.kind == "elided")
			.expect("elided segment");
		assert_eq!(elided.start_line, 2);
		assert_eq!(elided.end_line, 4);
	}

	#[test]
	fn summarizes_rust_use_run() {
		let code = "use std::fs;\nuse std::path::Path;\nuse std::collections::HashMap;\nuse \
		            std::sync::Arc;\nuse std::io;\n\nfn main() {}\n";
		let result = summarize(code, "fixture.rs");

		assert!(result.parsed);
		assert!(result.elided);
		let elided = result
			.segments
			.iter()
			.find(|seg| seg.kind == "elided")
			.expect("elided segment");
		assert_eq!(elided.start_line, 2);
		assert_eq!(elided.end_line, 4);
	}
}
