//! Syntax highlighting using syntect.
//!
//! Provides ANSI-colored output for code blocks. Takes theme colors as input
//! and maps syntect scopes to 11 semantic categories:
//! - comment, keyword, function, variable, string, number, type, operator,
//!   punctuation, inserted, deleted

use std::{cell::RefCell, collections::HashMap, sync::OnceLock};

use napi_derive::napi;
use syntect::parsing::{ParseState, Scope, ScopeStack, ScopeStackOp, SyntaxReference, SyntaxSet};

use crate::env_uint;

static SYNTAX_SET: OnceLock<SyntaxSet> = OnceLock::new();
static SCOPE_MATCHERS: OnceLock<ScopeMatchers> = OnceLock::new();

env_uint! {
	// Above this many input bytes, `highlight_code` skips the synchronous syntect highlight (O(code);
	// builds per-line parse state) and returns the original code unchanged. Defense-in-depth (F19/F3):
	// TS callers cap lower, but this bounds every native caller. Generous default; env-overridable.
	static MAX_HIGHLIGHT_BYTES: usize = "PI_NATIVE_MAX_HIGHLIGHT_BYTES" or 16 * 1024 * 1024 => [0, usize::MAX];
}

// Thread-local cache for scope -> color index lookups
thread_local! {
	static SCOPE_COLOR_CACHE: RefCell<HashMap<Scope, usize>> = RefCell::new(HashMap::with_capacity(256));
}

// Two LRU entries per calling thread protect interleaved Markdown/tool
// consumers. Admission bounds entry count and source/output/palette bytes, NOT
// parser heap. Expiry is lazy, sliding reuse expiry: idle allocations remain
// until another highlight call or thread exit; this is not a ten-second
// deallocation deadline. Ineligible inputs still take the unchanged full-color
// path.
const CHECKPOINT_ENTRIES: usize = 2;
const CHECKPOINT_INPUT_BYTES: usize = 200_000;
const CHECKPOINT_OUTPUT_BYTES: usize = 2 * 1024 * 1024;
const CHECKPOINT_MAX_AGE: std::time::Duration = std::time::Duration::from_secs(10);

struct HighlightCheckpoint {
	code:        String,
	lang:        Option<String>,
	palette:     [String; 11],
	offset:      usize,
	output:      String,
	parse_state: ParseState,
	scope_stack: ScopeStack,
	created:     std::time::Instant,
}

thread_local! {
	static HIGHLIGHT_CHECKPOINT: RefCell<Vec<HighlightCheckpoint>> = const { RefCell::new(Vec::new()) };
}

fn get_syntax_set() -> &'static SyntaxSet {
	SYNTAX_SET.get_or_init(SyntaxSet::load_defaults_newlines)
}

/// Pre-compiled scope patterns for fast matching.
struct ScopeMatchers {
	// Comment (index 0)
	comment: Scope,

	// String (index 4)
	string:             Scope,
	constant_character: Scope,
	meta_string:        Scope,

	// Number (index 5)
	constant_numeric: Scope,
	constant_integer: Scope,
	constant:         Scope,

	// Keyword (index 1)
	keyword:          Scope,
	storage_type:     Scope,
	storage_modifier: Scope,

	// Function (index 2)
	entity_name_function: Scope,
	support_function:     Scope,
	meta_function_call:   Scope,
	variable_function:    Scope,

	// Type (index 6)
	entity_name_type:      Scope,
	support_type:          Scope,
	support_class:         Scope,
	entity_name_class:     Scope,
	entity_name_struct:    Scope,
	entity_name_enum:      Scope,
	entity_name_interface: Scope,
	entity_name_trait:     Scope,

	// Operator (index 7)
	keyword_operator:     Scope,
	punctuation_accessor: Scope,

	// Punctuation (index 8)
	punctuation: Scope,

	// Variable (index 3)
	variable:    Scope,
	entity_name: Scope,
	meta_path:   Scope,

	// Diff (indices 9, 10)
	markup_inserted:  Scope,
	markup_deleted:   Scope,
	meta_diff_header: Scope,
	meta_diff_range:  Scope,
}

impl ScopeMatchers {
	fn new() -> Self {
		Self {
			comment:               Scope::new("comment").unwrap(),
			string:                Scope::new("string").unwrap(),
			constant_character:    Scope::new("constant.character").unwrap(),
			meta_string:           Scope::new("meta.string").unwrap(),
			constant_numeric:      Scope::new("constant.numeric").unwrap(),
			constant_integer:      Scope::new("constant.integer").unwrap(),
			constant:              Scope::new("constant").unwrap(),
			keyword:               Scope::new("keyword").unwrap(),
			storage_type:          Scope::new("storage.type").unwrap(),
			storage_modifier:      Scope::new("storage.modifier").unwrap(),
			entity_name_function:  Scope::new("entity.name.function").unwrap(),
			support_function:      Scope::new("support.function").unwrap(),
			meta_function_call:    Scope::new("meta.function-call").unwrap(),
			variable_function:     Scope::new("variable.function").unwrap(),
			entity_name_type:      Scope::new("entity.name.type").unwrap(),
			support_type:          Scope::new("support.type").unwrap(),
			support_class:         Scope::new("support.class").unwrap(),
			entity_name_class:     Scope::new("entity.name.class").unwrap(),
			entity_name_struct:    Scope::new("entity.name.struct").unwrap(),
			entity_name_enum:      Scope::new("entity.name.enum").unwrap(),
			entity_name_interface: Scope::new("entity.name.interface").unwrap(),
			entity_name_trait:     Scope::new("entity.name.trait").unwrap(),
			keyword_operator:      Scope::new("keyword.operator").unwrap(),
			punctuation_accessor:  Scope::new("punctuation.accessor").unwrap(),
			punctuation:           Scope::new("punctuation").unwrap(),
			variable:              Scope::new("variable").unwrap(),
			entity_name:           Scope::new("entity.name").unwrap(),
			meta_path:             Scope::new("meta.path").unwrap(),
			markup_inserted:       Scope::new("markup.inserted").unwrap(),
			markup_deleted:        Scope::new("markup.deleted").unwrap(),
			meta_diff_header:      Scope::new("meta.diff.header").unwrap(),
			meta_diff_range:       Scope::new("meta.diff.range").unwrap(),
		}
	}
}

fn get_scope_matchers() -> &'static ScopeMatchers {
	SCOPE_MATCHERS.get_or_init(ScopeMatchers::new)
}

/// Theme colors for syntax highlighting.
/// Each color is an ANSI escape sequence (e.g., "\x1b[38;2;255;0;0m").
#[derive(Debug, Default)]
#[napi(object)]
pub struct HighlightColors {
	/// ANSI color for comments.
	pub comment:     String,
	/// ANSI color for keywords.
	pub keyword:     String,
	/// ANSI color for function names.
	pub function:    String,
	/// ANSI color for variables and identifiers.
	pub variable:    String,
	/// ANSI color for string literals.
	pub string:      String,
	/// ANSI color for numeric literals.
	pub number:      String,
	/// ANSI color for type identifiers.
	pub r#type:      String,
	/// ANSI color for operators.
	pub operator:    String,
	/// ANSI color for punctuation tokens.
	pub punctuation: String,
	/// ANSI color for diff inserted lines.
	pub inserted:    Option<String>,
	/// ANSI color for diff deleted lines.
	pub deleted:     Option<String>,
}

/// Language alias mappings: (aliases, target syntax name).
/// Used for languages not in syntect's default set or with non-standard names.
const LANG_ALIASES: &[(&[&str], &str)] = &[
	(&["ts", "tsx", "typescript", "js", "jsx", "javascript", "mjs", "cjs"], "JavaScript"),
	(&["py", "python"], "Python"),
	(&["rb", "ruby"], "Ruby"),
	(&["rs", "rust"], "Rust"),
	(&["go", "golang"], "Go"),
	(&["java"], "Java"),
	(&["kt", "kotlin"], "Java"),
	(&["swift"], "Objective-C"),
	(&["c", "h"], "C"),
	(&["cpp", "cc", "cxx", "c++", "hpp", "hxx", "hh"], "C++"),
	(&["cs", "csharp"], "C#"),
	(&["php"], "PHP"),
	(&["sh", "bash", "zsh", "shell"], "Bash"),
	(&["ps1", "powershell"], "PowerShell"),
	(&["html", "htm", "astro", "vue", "svelte"], "HTML"),
	(&["css"], "CSS"),
	(&["scss"], "SCSS"),
	(&["sass"], "Sass"),
	(&["less"], "LESS"),
	(&["json"], "JSON"),
	(&["yaml", "yml"], "YAML"),
	(&["toml"], "TOML"),
	(&["xml"], "XML"),
	(&["md", "markdown"], "Markdown"),
	(&["sql"], "SQL"),
	(&["lua"], "Lua"),
	(&["perl", "pl", "pm"], "Perl"),
	(&["r"], "R"),
	(&["scala"], "Scala"),
	(&["clj", "clojure"], "Clojure"),
	(&["ex", "exs", "elixir"], "Ruby"),
	(&["erl", "erlang"], "Erlang"),
	(&["hs", "haskell"], "Haskell"),
	(&["ml", "ocaml"], "OCaml"),
	(&["vim"], "VimL"),
	(&["graphql", "gql"], "GraphQL"),
	(&["proto", "protobuf"], "Protocol Buffers"),
	(&["tf", "hcl", "terraform"], "Terraform"),
	(&["dockerfile", "docker", "containerfile"], "Dockerfile"),
	(&["makefile", "make", "just", "justfile"], "Makefile"),
	(&["cmake", "cmakelists"], "CMake"),
	(&["ini", "cfg", "conf", "config", "properties"], "INI"),
	(&["diff", "patch"], "Diff"),
	(&["gitignore", "gitattributes", "gitmodules"], "Git Ignore"),
];

/// Find syntax name from alias table using case-insensitive comparison.
#[inline]
fn find_alias(lang: &str) -> Option<&'static str> {
	LANG_ALIASES
		.iter()
		.find(|(aliases, _)| aliases.iter().any(|a| lang.eq_ignore_ascii_case(a)))
		.map(|(_, target)| *target)
}

/// Check if language is in the alias table.
#[inline]
fn is_known_alias(lang: &str) -> bool {
	LANG_ALIASES
		.iter()
		.any(|(aliases, _)| aliases.iter().any(|a| lang.eq_ignore_ascii_case(a)))
}

/// Compute the color index for a single scope (uncached).
#[inline]
fn compute_scope_color(s: Scope) -> usize {
	let m = get_scope_matchers();

	// Comment (index 0)
	if m.comment.is_prefix_of(s) {
		return 0;
	}

	// Diff inserted (index 9)
	if m.markup_inserted.is_prefix_of(s) {
		return 9;
	}

	// Diff deleted (index 10)
	if m.markup_deleted.is_prefix_of(s) {
		return 10;
	}

	// Diff header/range -> keyword (index 1)
	if m.meta_diff_header.is_prefix_of(s) || m.meta_diff_range.is_prefix_of(s) {
		return 1;
	}

	// String (index 4)
	if m.string.is_prefix_of(s)
		|| m.constant_character.is_prefix_of(s)
		|| m.meta_string.is_prefix_of(s)
	{
		return 4;
	}

	// Number (index 5)
	if m.constant_numeric.is_prefix_of(s) || m.constant_integer.is_prefix_of(s) {
		return 5;
	}

	// Keyword (index 1)
	if m.keyword.is_prefix_of(s)
		|| m.storage_type.is_prefix_of(s)
		|| m.storage_modifier.is_prefix_of(s)
	{
		return 1;
	}

	// Function (index 2)
	if m.entity_name_function.is_prefix_of(s)
		|| m.support_function.is_prefix_of(s)
		|| m.meta_function_call.is_prefix_of(s)
		|| m.variable_function.is_prefix_of(s)
	{
		return 2;
	}

	// Type (index 6)
	if m.entity_name_type.is_prefix_of(s)
		|| m.support_type.is_prefix_of(s)
		|| m.support_class.is_prefix_of(s)
		|| m.entity_name_class.is_prefix_of(s)
		|| m.entity_name_struct.is_prefix_of(s)
		|| m.entity_name_enum.is_prefix_of(s)
		|| m.entity_name_interface.is_prefix_of(s)
		|| m.entity_name_trait.is_prefix_of(s)
	{
		return 6;
	}

	// Operator (index 7)
	if m.keyword_operator.is_prefix_of(s) || m.punctuation_accessor.is_prefix_of(s) {
		return 7;
	}

	// Punctuation (index 8)
	if m.punctuation.is_prefix_of(s) {
		return 8;
	}

	// Variable (index 3)
	if m.variable.is_prefix_of(s) || m.entity_name.is_prefix_of(s) || m.meta_path.is_prefix_of(s) {
		return 3;
	}

	// Generic constant -> number (index 5)
	if m.constant.is_prefix_of(s) {
		return 5;
	}

	// No match
	usize::MAX
}

/// Determine the semantic color category from a scope stack.
/// Uses per-scope caching to avoid repeated prefix checks.
#[inline]
fn scope_to_color_index(scope: &ScopeStack) -> usize {
	SCOPE_COLOR_CACHE.with(|cache| {
		let mut cache = cache.borrow_mut();

		// Walk from innermost to outermost scope
		for s in scope.as_slice().iter().rev() {
			let color_idx = *cache.entry(*s).or_insert_with(|| compute_scope_color(*s));
			if color_idx != usize::MAX {
				return color_idx;
			}
		}

		usize::MAX
	})
}

/// Find the appropriate syntax for a language name.
fn find_syntax<'a>(ss: &'a SyntaxSet, lang: &str) -> Option<&'a SyntaxReference> {
	// Direct name/token match (syntect APIs are case-insensitive)
	if let Some(syn) = ss.find_syntax_by_token(lang) {
		return Some(syn);
	}

	// Extension-based match
	if let Some(syn) = ss.find_syntax_by_extension(lang) {
		return Some(syn);
	}

	// Alias lookup for languages not in syntect's default set
	let alias = find_alias(lang)?;

	ss.find_syntax_by_name(alias)
		.or_else(|| ss.find_syntax_by_token(alias))
}

/// Highlight code and return ANSI-colored lines.
///
/// # Arguments
/// * `code` - The source code to highlight
/// * `lang` - Language identifier (e.g., "rust", "typescript", "python")
/// * `colors` - Theme colors as ANSI escape sequences
///
/// # Returns
/// Highlighted code with ANSI color codes, or the original code if highlighting
/// fails.
#[napi]
pub fn highlight_code(code: String, lang: Option<String>, colors: HighlightColors) -> String {
	// Defense-in-depth (F19/F3): above the cap, skip the synchronous highlight and
	// return the original code — the same fallback used when highlighting fails.
	if code.len() > *MAX_HIGHLIGHT_BYTES {
		HIGHLIGHT_CHECKPOINT.with(|slot| {
			slot
				.borrow_mut()
				.retain(|entry| entry.created.elapsed() <= CHECKPOINT_MAX_AGE);
		});
		return code;
	}
	let inserted = colors.inserted.as_deref().unwrap_or("");
	let deleted = colors.deleted.as_deref().unwrap_or("");

	// Color palette as array for quick indexing
	let palette = [
		colors.comment.as_str(),     // 0
		colors.keyword.as_str(),     // 1
		colors.function.as_str(),    // 2
		colors.variable.as_str(),    // 3
		colors.string.as_str(),      // 4
		colors.number.as_str(),      // 5
		colors.r#type.as_str(),      // 6
		colors.operator.as_str(),    // 7
		colors.punctuation.as_str(), // 8
		inserted,                    // 9
		deleted,                     // 10
	];

	let ss = get_syntax_set();

	// Find syntax for the language
	let syntax = match &lang {
		Some(l) => find_syntax(ss, l),
		None => None,
	}
	.unwrap_or_else(|| ss.find_syntax_plain_text());

	let eligible = code.len() <= CHECKPOINT_INPUT_BYTES
		&& lang.as_ref().is_none_or(|value| value.len() <= 256)
		&& palette.iter().map(|color| color.len()).sum::<usize>() <= 4096;
	let previous = HIGHLIGHT_CHECKPOINT.with(|slot| {
		let mut entries = slot.borrow_mut();
		entries.retain(|entry| entry.created.elapsed() <= CHECKPOINT_MAX_AGE);
		let index = entries.iter().rposition(|entry| {
			eligible
				&& entry.lang == lang
				&& entry.palette.iter().zip(palette).all(|(a, b)| a == b)
				&& code.starts_with(&entry.code)
		});
		index.map(|index| entries.remove(index))
	});
	let (mut parse_state, mut scope_stack, mut result, start) = match previous {
		Some(entry) => (entry.parse_state, entry.scope_stack, entry.output, entry.offset),
		None => {
			(ParseState::new(syntax), ScopeStack::new(), String::with_capacity(code.len() * 2), 0)
		},
	};
	// Only newline-terminated lines are stable. Reparse the incomplete final line
	// from its pre-line state; an appended quote/comment delimiter can recolor it.
	let stable_end = code.rfind('\n').map_or(0, |index| index + 1);
	let mut offset = start;
	let mut checkpoint = None;
	let mut parse_failed = false;
	for line in syntect::util::LinesWithEndings::from(&code[start..]) {
		if eligible && offset == stable_end && result.len() <= CHECKPOINT_OUTPUT_BYTES {
			checkpoint = Some((parse_state.clone(), scope_stack.clone(), result.clone()));
		}
		offset += line.len();
		#[cfg(test)]
		PARSED_LINES.with(|count| count.set(count.get() + 1));
		let Ok(ops) = parse_state.parse_line(line, ss) else {
			// Preserve the existing error output, but never retain an errored state.
			parse_failed = true;
			result.push_str(line);
			continue;
		};

		let mut prev_end = 0;
		for (offset, op) in ops {
			let offset = offset.min(line.len());

			// Output text BEFORE this operation using current scope
			if offset > prev_end {
				let text = &line[prev_end..offset];
				let color_idx = scope_to_color_index(&scope_stack);

				if color_idx < palette.len() && !palette[color_idx].is_empty() {
					result.push_str(palette[color_idx]);
					result.push_str(text);
					result.push_str("\x1b[39m");
				} else {
					result.push_str(text);
				}
			}
			prev_end = offset;

			// Now apply scope operation for NEXT segment
			match op {
				ScopeStackOp::Push(scope) => {
					scope_stack.push(scope);
				},
				ScopeStackOp::Pop(count) => {
					for _ in 0..count {
						scope_stack.pop();
					}
				},
				ScopeStackOp::Restore | ScopeStackOp::Clear(_) | ScopeStackOp::Noop => {},
			}
		}

		// Output remaining text with current scope
		if prev_end < line.len() {
			let text = &line[prev_end..];
			let color_idx = scope_to_color_index(&scope_stack);

			if color_idx < palette.len() && !palette[color_idx].is_empty() {
				result.push_str(palette[color_idx]);
				result.push_str(text);
				result.push_str("\x1b[39m");
			} else {
				result.push_str(text);
			}
		}
	}

	if eligible && !parse_failed && result.len() <= CHECKPOINT_OUTPUT_BYTES {
		if stable_end == code.len() {
			checkpoint = Some((parse_state, scope_stack, result.clone()));
		}
		if let Some((parse_state, scope_stack, output)) = checkpoint {
			HIGHLIGHT_CHECKPOINT.with(|slot| {
				let mut entries = slot.borrow_mut();
				if entries.len() == CHECKPOINT_ENTRIES {
					entries.remove(0);
				}
				entries.push(HighlightCheckpoint {
					code,
					lang,
					palette: palette.map(str::to_owned),
					offset: stable_end,
					output,
					parse_state,
					scope_stack,
					created: std::time::Instant::now(),
				});
			});
		}
	}
	result
}

/// Check if a language is supported for highlighting.
/// Returns true if the language has either direct support or a fallback
/// mapping.
#[napi]
pub fn supports_language(lang: String) -> bool {
	if is_known_alias(&lang) {
		return true;
	}

	// Fall back to direct syntax lookup
	let ss = get_syntax_set();
	find_syntax(ss, &lang).is_some()
}

/// Get list of supported languages.
#[napi]
pub fn get_supported_languages() -> Vec<String> {
	let ss = get_syntax_set();
	ss.syntaxes().iter().map(|s| s.name.clone()).collect()
}

#[cfg(test)]
thread_local! {
	static PARSED_LINES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
mod incremental_tests {
	use super::*;

	fn colors() -> HighlightColors {
		HighlightColors {
			comment:     "\x1b[31m".into(),
			keyword:     "\x1b[32m".into(),
			function:    "\x1b[33m".into(),
			variable:    "\x1b[34m".into(),
			string:      "\x1b[35m".into(),
			number:      "\x1b[36m".into(),
			r#type:      "\x1b[91m".into(),
			operator:    "\x1b[92m".into(),
			punctuation: "\x1b[93m".into(),
			inserted:    Some("\x1b[94m".into()),
			deleted:     Some("\x1b[95m".into()),
		}
	}

	#[test]
	fn append_at_every_character_matches_cold_multiline_output() {
		for (lang, code) in [
			("cpp", "/* hello\n世界 */\nauto s = R\"tag(first\nsecond)tag\";\r\nint n = 42;"),
			("python", "s = \"\"\"first\nsecond\"\"\"\r\n# 注釈\nprint(s)"),
			("bash", "cat <<'EOF'\nhello 世界\nEOF\necho done\n"),
			("html", "<script>\n/* hi\nthere */ let s='x';\n</script>\n"),
			("rust", "/* outer\n/* inner */\n*/ let s = r#\"a\nb\"#;\n"),
			("diff", "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n"),
		] {
			HIGHLIGHT_CHECKPOINT.with(|slot| std::mem::take(&mut *slot.borrow_mut()));
			for end in code
				.char_indices()
				.map(|(i, _)| i)
				.chain(std::iter::once(code.len()))
			{
				let input = &code[..end];
				let warm = highlight_code(input.into(), Some(lang.into()), colors());
				let checkpoint =
					HIGHLIGHT_CHECKPOINT.with(|slot| std::mem::take(&mut *slot.borrow_mut()));
				let cold = highlight_code(input.into(), Some(lang.into()), colors());
				HIGHLIGHT_CHECKPOINT.with(|slot| *slot.borrow_mut() = checkpoint);
				assert_eq!(warm, cold, "{lang} byte {end}");
			}
		}
	}

	#[test]
	fn edits_language_and_theme_changes_match_cold() {
		for (code, lang, changed_theme) in [
			("/* open\nint x;", "cpp", false),
			("// edit\nint x;", "cpp", false),
			("// edit\nint x;\n42", "python", false),
			("// edit\nint x;\n42\n", "python", true),
			("", "rust", false),
		] {
			let make_colors = || {
				if changed_theme {
					HighlightColors::default()
				} else {
					colors()
				}
			};
			let warm = highlight_code(code.into(), Some(lang.into()), make_colors());
			let checkpoint = HIGHLIGHT_CHECKPOINT.with(|slot| std::mem::take(&mut *slot.borrow_mut()));
			let cold = highlight_code(code.into(), Some(lang.into()), make_colors());
			assert_eq!(warm, cold);
			HIGHLIGHT_CHECKPOINT.with(|slot| *slot.borrow_mut() = checkpoint);
		}
	}

	#[test]
	fn admission_and_age_bound_retention_not_coloring() {
		let code = "// hello\n".repeat(100);
		highlight_code(code.clone(), Some("cpp".into()), colors());
		HIGHLIGHT_CHECKPOINT.with(|slot| {
			slot.borrow_mut().last_mut().unwrap().created -=
				CHECKPOINT_MAX_AGE + std::time::Duration::from_secs(1);
		});
		PARSED_LINES.with(|count| count.set(0));
		highlight_code(format!("{code}42"), Some("cpp".into()), colors());
		assert_eq!(PARSED_LINES.with(|count| count.get()), 101);
		HIGHLIGHT_CHECKPOINT.with(|slot| slot.borrow_mut().clear());
		let large = "x\n".repeat(CHECKPOINT_INPUT_BYTES / 2 + 1);
		assert_eq!(highlight_code(large.clone(), None, colors()), large);
		assert!(HIGHLIGHT_CHECKPOINT.with(|slot| slot.borrow().is_empty()));
		let mut palette = colors();
		palette.comment = "x".repeat(4097);
		highlight_code("// x\n".into(), Some("cpp".into()), palette);
		assert!(HIGHLIGHT_CHECKPOINT.with(|slot| slot.borrow().is_empty()));
	}

	#[test]
	fn ineligible_consumer_does_not_evict_active_block() {
		for bytes in [CHECKPOINT_INPUT_BYTES + 1, 17 * 1024 * 1024] {
			HIGHLIGHT_CHECKPOINT.with(|slot| slot.borrow_mut().clear());
			let a = "// retained A\n".repeat(100);
			highlight_code(a.clone(), Some("cpp".into()), colors());
			let b = "x".repeat(bytes);
			assert_eq!(highlight_code(b.clone(), None, colors()), b);
			PARSED_LINES.with(|count| count.set(0));
			let appended = format!("{a}int answer = 42;\n");
			let warm = highlight_code(appended.clone(), Some("cpp".into()), colors());
			assert_eq!(PARSED_LINES.with(|count| count.get()), 1, "B bytes {bytes}");
			HIGHLIGHT_CHECKPOINT.with(|slot| slot.borrow_mut().clear());
			assert_eq!(warm, highlight_code(appended, Some("cpp".into()), colors()));
		}
	}

	#[test]
	fn cache_evicts_lru_and_expires_all_entries_lazily() {
		HIGHLIGHT_CHECKPOINT.with(|slot| slot.borrow_mut().clear());
		for name in ["A", "B", "A", "C"] {
			highlight_code(format!("// {name}\n"), Some("cpp".into()), colors());
		}
		HIGHLIGHT_CHECKPOINT.with(|slot| {
			let mut entries = slot.borrow_mut();
			assert_eq!(entries.len(), CHECKPOINT_ENTRIES);
			assert_eq!(entries[0].code, "// A\n");
			assert_eq!(entries[1].code, "// C\n");
			for entry in entries.iter_mut() {
				entry.created -= CHECKPOINT_MAX_AGE + std::time::Duration::from_secs(1);
			}
			// Lazy expiry does not asynchronously free idle entries.
			assert_eq!(entries.len(), CHECKPOINT_ENTRIES);
		});
		let mut palette = colors();
		palette.comment = "x".repeat(4097);
		highlight_code("// ineligible\n".into(), Some("cpp".into()), palette);
		assert!(HIGHLIGHT_CHECKPOINT.with(|slot| slot.borrow().is_empty()));
	}

	#[test]
	fn interleaved_blocks_preserve_append_checkpoint() {
		let a = "// block A\n".repeat(100);
		highlight_code(a.clone(), Some("cpp".into()), colors());
		highlight_code("/* block B */\n".repeat(100), Some("cpp".into()), colors());
		PARSED_LINES.with(|count| count.set(0));
		let appended = format!("{a}int answer = 42;\n");
		let warm = highlight_code(appended.clone(), Some("cpp".into()), colors());
		assert_eq!(PARSED_LINES.with(|count| count.get()), 1);
		HIGHLIGHT_CHECKPOINT.with(|slot| std::mem::take(&mut *slot.borrow_mut()));
		assert_eq!(warm, highlight_code(appended, Some("cpp".into()), colors()));
	}

	#[test]
	fn growing_block_only_parses_the_changed_suffix() {
		let prefix = "template<class T> T square(T x) { return x*x; }\n".repeat(1000);
		highlight_code(prefix.clone(), Some("cpp".into()), HighlightColors::default());
		PARSED_LINES.with(|count| count.set(0));
		let code = format!("{prefix}int value = 42;\n");
		assert_eq!(
			highlight_code(code.clone(), Some("cpp".into()), HighlightColors::default()),
			code
		);
		assert!(PARSED_LINES.with(|count| count.get()) <= 2, "append reparsed the unchanged prefix");
	}
}

#[cfg(test)]
mod cap_tests {
	use super::*;

	#[test]
	fn oversized_code_is_returned_unhighlighted() {
		let code = "x".repeat(17 * 1024 * 1024);
		let out = highlight_code(code.clone(), Some("rust".to_string()), HighlightColors::default());
		assert_eq!(out, code, "above the cap highlight_code must return the original code unchanged");
	}
}
