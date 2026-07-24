//! AST-aware structural search and rewrite powered by ast-grep.

use std::{
	collections::{BTreeMap, BTreeSet, HashMap},
	path::{Path, PathBuf},
};

use ast_grep_core::{MatchStrictness, matcher::Pattern, source::Edit, tree_sitter::LanguageExt};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use pi_ast::{
	SupportLang,
	ops::{self as shared_ops},
};

use crate::{fs_cache, glob_util, task};

const DEFAULT_FIND_LIMIT: u32 = 50;

/// ast-grep pattern strictness (controls how patterns match syntax).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[napi(string_enum)]
pub enum AstMatchStrictness {
	/// Match at the concrete syntax tree level.
	#[napi(value = "cst")]
	Cst,
	/// Balanced default suitable for most searches.
	#[napi(value = "smart")]
	Smart,
	/// Match at the AST level.
	#[napi(value = "ast")]
	Ast,
	/// More permissive matching.
	#[napi(value = "relaxed")]
	Relaxed,
	/// Match structural signatures.
	#[napi(value = "signature")]
	Signature,
	/// Template-style pattern matching.
	#[napi(value = "template")]
	Template,
}

impl From<AstMatchStrictness> for MatchStrictness {
	fn from(value: AstMatchStrictness) -> Self {
		match value {
			AstMatchStrictness::Cst => Self::Cst,
			AstMatchStrictness::Smart => Self::Smart,
			AstMatchStrictness::Ast => Self::Ast,
			AstMatchStrictness::Relaxed => Self::Relaxed,
			AstMatchStrictness::Signature => Self::Signature,
			AstMatchStrictness::Template => Self::Template,
		}
	}
}

fn resolve_strictness(value: Option<AstMatchStrictness>) -> MatchStrictness {
	value.map_or(MatchStrictness::Smart, Into::into)
}

/// Options for `astGrep`: patterns, scan scope, and match limits.
#[napi(object)]
pub struct AstFindOptions<'env> {
	/// ast-grep patterns to search for (OR across patterns).
	pub patterns: Option<Vec<String>>,
	/// Language override; otherwise inferred from file extension per candidate.
	pub lang: Option<String>,
	/// Single file or directory to scan (combined with `glob` when set).
	pub path: Option<String>,
	/// Optional glob filter relative to the search root.
	pub glob: Option<String>,
	/// Rule selector for multi-rule ast-grep configurations.
	pub selector: Option<String>,
	/// Pattern strictness; defaults to smart matching when omitted.
	pub strictness: Option<AstMatchStrictness>,
	/// Maximum matches to return after `offset` (default applies when omitted).
	pub limit: Option<u32>,
	/// Number of leading matches to skip before applying `limit`.
	pub offset: Option<u32>,
	/// When true, include meta-variable bindings per match.
	pub include_meta: Option<bool>,
	/// Reserved for contextual snippets; not used by the current native find
	/// path.
	pub context: Option<u32>,
	/// Optional cancellation handle (library-specific).
	pub signal: Option<Unknown<'env>>,
	/// Wall-clock timeout for the worker task in milliseconds.
	pub timeout_ms: Option<u32>,
}

/// One ast-grep match with source range and optional meta-variables.
#[napi(object)]
pub struct AstFindMatch {
	/// Display path of the matching file.
	pub path: String,
	/// Matched source text.
	pub text: String,
	/// Start byte offset in the file (UTF-8 byte index).
	pub byte_start: u32,
	/// End byte offset in the file (exclusive UTF-8 byte index).
	pub byte_end: u32,
	/// 1-based start line.
	pub start_line: u32,
	/// 1-based start column.
	pub start_column: u32,
	/// 1-based end line.
	pub end_line: u32,
	/// 1-based end column.
	pub end_column: u32,
	/// Meta-variable name to captured text, when `includeMeta` was enabled.
	pub meta_variables: Option<HashMap<String, String>>,
}

/// Aggregated search statistics and any parse or compile diagnostics.
#[napi(object)]
pub struct AstFindResult {
	/// Page of matches after sort, offset, and limit.
	pub matches: Vec<AstFindMatch>,
	/// Total matches found before paging (can exceed `matches.length`).
	pub total_matches: u32,
	/// Distinct files that contained at least one match.
	pub files_with_matches: u32,
	/// Files examined for the query.
	pub files_searched: u32,
	/// True when results were truncated by `limit`.
	pub limit_reached: bool,
	/// Non-fatal parse or pattern errors collected during the run.
	pub parse_errors: Option<Vec<String>>,
}

/// Options for `astEdit`: rewrite rules, scan scope, safety limits, and
/// dry-run.
#[napi(object)]
pub struct AstReplaceOptions<'env> {
	/// Map of pattern string to replacement template.
	pub rewrites: Option<HashMap<String, String>>,
	/// Language override; otherwise inferred from discovered files.
	pub lang: Option<String>,
	/// Single file or directory to rewrite.
	pub path: Option<String>,
	/// Optional glob filter within the search root.
	pub glob: Option<String>,
	/// Rule selector for multi-rule configurations.
	pub selector: Option<String>,
	/// Pattern strictness for rewrites.
	pub strictness: Option<AstMatchStrictness>,
	/// When true (default), compute changes without writing files.
	pub dry_run: Option<bool>,
	/// Cap on replacement applications across all files.
	pub max_replacements: Option<u32>,
	/// Cap on distinct files that may be modified.
	pub max_files: Option<u32>,
	/// Fail the operation when a file cannot be parsed for rewriting.
	pub fail_on_parse_error: Option<bool>,
	/// Optional cancellation handle.
	pub signal: Option<Unknown<'env>>,
	/// Wall-clock timeout for the worker task in milliseconds.
	pub timeout_ms: Option<u32>,
}

/// One textual replacement applied to a file (before/after slice and
/// coordinates).
#[napi(object)]
pub struct AstReplaceChange {
	/// File path for this change.
	pub path: String,
	/// Original matched text.
	pub before: String,
	/// Replacement text.
	pub after: String,
	/// Start byte offset of the replaced span.
	pub byte_start: u32,
	/// End byte offset of the replaced span (exclusive).
	pub byte_end: u32,
	/// Length of deleted text in bytes (may differ from `byteEnd - byteStart`
	/// for edge cases).
	pub deleted_length: u32,
	/// 1-based start line of the match.
	pub start_line: u32,
	/// 1-based start column.
	pub start_column: u32,
	/// 1-based end line.
	pub end_line: u32,
	/// 1-based end column.
	pub end_column: u32,
}

/// Per-file replacement count after an `astEdit` run.
#[napi(object)]
pub struct AstReplaceFileChange {
	/// File that had replacements.
	pub path: String,
	/// Number of replacements in that file.
	pub count: u32,
}

/// Summary of an ast-grep rewrite pass, including whether disk writes occurred.
#[napi(object)]
pub struct AstReplaceResult {
	/// Individual replacement records (may be large).
	pub changes: Vec<AstReplaceChange>,
	/// Replacement counts grouped by file.
	pub file_changes: Vec<AstReplaceFileChange>,
	/// Total replacements applied or previewed.
	pub total_replacements: u32,
	/// Files that had at least one replacement.
	pub files_touched: u32,
	/// Files considered for rewriting.
	pub files_searched: u32,
	/// False when `dryRun` prevented writing.
	pub applied: bool,
	/// True when limits stopped further replacements.
	pub limit_reached: bool,
	/// Parse or pattern errors when not failing the whole operation.
	pub parse_errors: Option<Vec<String>>,
}

struct FileCandidate {
	absolute_path: PathBuf,
	display_path: String,
}

struct PendingFileChange {
	change: AstReplaceChange,
	edit: Edit<String>,
}

fn to_u32(value: usize) -> u32 {
	value.min(u32::MAX as usize) as u32
}

fn resolve_supported_lang(value: &str) -> Result<SupportLang> {
	shared_ops::resolve_supported_lang(value).map_err(|err| Error::from_reason(err.to_string()))
}

fn resolve_language(lang: Option<&str>, file_path: &Path) -> Result<SupportLang> {
	shared_ops::resolve_language(lang, file_path).map_err(|err| Error::from_reason(err.to_string()))
}

/// Returns true if the file's extension resolves to a supported language.
/// When `lang` is explicitly provided, all files are considered candidates
/// (the user chose to treat them as that language). When `lang` is None,
/// only files with recognizable code extensions are included.
fn is_supported_file(file_path: &Path, explicit_lang: Option<&str>) -> bool {
	shared_ops::is_supported_file(file_path, explicit_lang)
}

fn infer_single_replace_lang(
	candidates: &[FileCandidate],
	ct: &task::CancelToken,
) -> Result<String> {
	let mut inferred = BTreeSet::new();
	let mut unresolved = Vec::new();
	for candidate in candidates {
		ct.heartbeat()?;
		match resolve_language(None, &candidate.absolute_path) {
			Ok(language) => {
				inferred.insert(language.canonical_name().to_string());
			},
			Err(err) => unresolved.push(format!("{}: {}", candidate.display_path, err)),
		}
	}
	if !unresolved.is_empty() {
		let details = unresolved
			.into_iter()
			.map(|entry| format!("- {entry}"))
			.collect::<Vec<_>>()
			.join("\n");
		return Err(Error::from_reason(format!(
			"`lang` is required for ast_edit when language cannot be inferred from all \
			 files:\n{details}"
		)));
	}
	if inferred.is_empty() {
		return Err(Error::from_reason(
			"`lang` is required for ast_edit when no files match path/glob".to_string(),
		));
	}
	if inferred.len() > 1 {
		return Err(Error::from_reason(format!(
			"`lang` is required for ast_edit when path/glob resolves to multiple languages: {}",
			inferred.into_iter().collect::<Vec<_>>().join(", ")
		)));
	}
	Ok(inferred.into_iter().next().expect("non-empty inferred set"))
}
fn normalize_search_path(path: Option<String>) -> Result<PathBuf> {
	let raw = path.unwrap_or_else(|| ".".to_string());
	let candidate = PathBuf::from(raw.trim());
	let absolute = if candidate.is_absolute() {
		candidate
	} else {
		std::env::current_dir()
			.map_err(|err| Error::from_reason(format!("Failed to resolve cwd: {err}")))?
			.join(candidate)
	};
	Ok(std::fs::canonicalize(&absolute).unwrap_or(absolute))
}

fn collect_from_entries(
	root: &Path,
	entries: &[fs_cache::GlobMatch],
	glob_set: Option<&globset::GlobSet>,
	mentions_node_modules: bool,
	ct: &task::CancelToken,
) -> Result<Vec<FileCandidate>> {
	let mut files = Vec::new();
	for entry in entries {
		ct.heartbeat()?;
		if entry.file_type != fs_cache::FileType::File {
			continue;
		}
		let relative = entry.path.replace('\\', "/");
		if fs_cache::should_skip_path(Path::new(&relative), mentions_node_modules) {
			continue;
		}
		if let Some(glob_set) = glob_set
			&& !glob_set.is_match(&relative)
		{
			continue;
		}
		files.push(FileCandidate { absolute_path: root.join(&relative), display_path: relative });
	}
	Ok(files)
}

fn collect_candidates(
	path: Option<String>,
	glob: Option<&str>,
	ct: &task::CancelToken,
) -> Result<Vec<FileCandidate>> {
	let search_path = normalize_search_path(path)?;
	let metadata = std::fs::metadata(&search_path)
		.map_err(|err| Error::from_reason(format!("Path not found: {err}")))?;
	if metadata.is_file() {
		let display_path = search_path
			.file_name()
			.and_then(|name| name.to_str())
			.map_or_else(
				|| search_path.to_string_lossy().into_owned(),
				std::string::ToString::to_string,
			);
		return Ok(vec![FileCandidate { absolute_path: search_path, display_path }]);
	}
	if !metadata.is_dir() {
		return Err(Error::from_reason(format!(
			"Search path must be a file or directory: {}",
			search_path.display()
		)));
	}

	let glob_set = glob_util::try_compile_glob(glob, false)?;
	let mentions_node_modules = glob.is_some_and(|value| value.contains("node_modules"));
	let skip_node_modules = !mentions_node_modules;
	let scan = fs_cache::get_or_scan(
		&search_path,
		fs_cache::ScanOptions {
			include_hidden: true,
			use_gitignore: true,
			skip_node_modules,
			follow_links: false,
			detail: fs_cache::ScanDetail::Minimal,
		},
		ct,
	)?;
	let mut files = collect_from_entries(
		&search_path,
		&scan.entries,
		glob_set.as_ref(),
		mentions_node_modules,
		ct,
	)?;

	if files.is_empty() && scan.cache_age_ms >= fs_cache::empty_recheck_ms() {
		let fresh = fs_cache::force_rescan(
			&search_path,
			fs_cache::ScanOptions {
				include_hidden: true,
				use_gitignore: true,
				skip_node_modules,
				follow_links: false,
				detail: fs_cache::ScanDetail::Minimal,
			},
			true,
			ct,
		)?;
		files =
			collect_from_entries(&search_path, &fresh, glob_set.as_ref(), mentions_node_modules, ct)?;
	}

	files.sort_by(|a, b| a.display_path.cmp(&b.display_path));
	Ok(files)
}

fn compile_pattern(
	pattern: &str,
	selector: Option<&str>,
	strictness: &MatchStrictness,
	lang: SupportLang,
) -> Result<Pattern> {
	shared_ops::compile_pattern(pattern, selector, strictness, lang)
		.map_err(|err| Error::from_reason(err.to_string()))
}

fn apply_edits(content: &str, edits: &[Edit<String>]) -> Result<String> {
	shared_ops::apply_edits(content, edits).map_err(|err| Error::from_reason(err.to_string()))
}

fn normalize_pattern_list(patterns: Option<Vec<String>>) -> Result<Vec<String>> {
	let mut normalized = Vec::new();
	let mut seen = BTreeSet::new();
	for raw in patterns.unwrap_or_default() {
		let pattern = raw.trim();
		if pattern.is_empty() {
			continue;
		}
		if seen.insert(pattern.to_string()) {
			normalized.push(pattern.to_string());
		}
	}
	if normalized.is_empty() {
		return Err(Error::from_reason(
			"`patterns` is required and must include at least one non-empty pattern".to_string(),
		));
	}
	Ok(normalized)
}

fn normalize_rewrite_map(
	rewrites: Option<HashMap<String, String>>,
) -> Result<Vec<(String, String)>> {
	let mut normalized = Vec::new();
	for (pattern, rewrite) in rewrites.unwrap_or_default() {
		if pattern.is_empty() {
			return Err(Error::from_reason(
				"`rewrites` keys must be non-empty pattern strings".to_string(),
			));
		}
		normalized.push((pattern, rewrite));
	}
	if normalized.is_empty() {
		return Err(Error::from_reason(
			"`rewrites` is required and must include at least one pattern->rewrite mapping"
				.to_string(),
		));
	}
	normalized.sort_by(|left, right| left.0.cmp(&right.0));
	Ok(normalized)
}
struct CompiledFindPattern {
	pattern: String,
	compiled_by_lang: HashMap<String, Pattern>,
	compile_errors_by_lang: HashMap<String, String>,
}

struct ResolvedCandidate {
	candidate: FileCandidate,
	language: Option<SupportLang>,
	language_error: Option<String>,
}

fn resolve_candidates_for_find(
	candidates: Vec<FileCandidate>,
	lang: Option<&str>,
	ct: &task::CancelToken,
) -> Result<(Vec<ResolvedCandidate>, HashMap<String, SupportLang>)> {
	let mut resolved = Vec::with_capacity(candidates.len());
	let mut languages = HashMap::new();

	for candidate in candidates {
		ct.heartbeat()?;
		match resolve_language(lang, &candidate.absolute_path) {
			Ok(language) => {
				let key = language.canonical_name().to_string();
				languages.entry(key).or_insert(language);
				resolved.push(ResolvedCandidate {
					candidate,
					language: Some(language),
					language_error: None,
				});
			},
			Err(err) => {
				resolved.push(ResolvedCandidate {
					candidate,
					language: None,
					language_error: Some(err.to_string()),
				});
			},
		}
	}

	Ok((resolved, languages))
}

fn compile_find_patterns(
	patterns: &[String],
	languages: &HashMap<String, SupportLang>,
	selector: Option<&str>,
	strictness: &MatchStrictness,
	ct: &task::CancelToken,
) -> Result<Vec<CompiledFindPattern>> {
	let mut compiled = Vec::with_capacity(patterns.len());

	for pattern in patterns {
		ct.heartbeat()?;
		let mut compiled_by_lang = HashMap::with_capacity(languages.len());
		let mut compile_errors_by_lang = HashMap::new();

		for (lang_key, &language) in languages {
			ct.heartbeat()?;
			match compile_pattern(pattern, selector, strictness, language) {
				Ok(compiled_pattern) => {
					compiled_by_lang.insert(lang_key.clone(), compiled_pattern);
				},
				Err(err) => {
					compile_errors_by_lang.insert(lang_key.clone(), err.to_string());
				},
			}
		}

		compiled.push(CompiledFindPattern {
			pattern: pattern.clone(),
			compiled_by_lang,
			compile_errors_by_lang,
		});
	}

	Ok(compiled)
}
/// Search source files with ast-grep patterns; returns a promise resolved on a
/// worker thread.
#[napi]
pub fn ast_grep(options: AstFindOptions<'_>) -> task::Promise<AstFindResult> {
	let AstFindOptions {
		patterns,
		lang,
		path,
		glob,
		selector,
		strictness,
		limit,
		offset,
		include_meta,
		context: _,
		signal,
		timeout_ms,
	} = options;

	let ct = task::CancelToken::new(timeout_ms, signal);
	let normalized_limit = limit.unwrap_or(DEFAULT_FIND_LIMIT).max(1);
	let normalized_offset = offset.unwrap_or(0);

	task::blocking("ast_grep", ct, move |ct| {
		let patterns = normalize_pattern_list(patterns)?;
		let strictness = resolve_strictness(strictness);
		let include_meta = include_meta.unwrap_or(false);
		let lang_str = lang.as_deref().map(str::trim).filter(|v| !v.is_empty());
		if let Some(lang) = lang_str {
			resolve_supported_lang(lang)?;
		}
		let candidates: Vec<_> = collect_candidates(path, glob.as_deref(), &ct)?
			.into_iter()
			.filter(|candidate| is_supported_file(&candidate.absolute_path, lang_str))
			.collect();

		let (resolved_candidates, languages) =
			resolve_candidates_for_find(candidates, lang_str, &ct)?;
		let compiled_patterns =
			compile_find_patterns(&patterns, &languages, selector.as_deref(), &strictness, &ct)?;
		let files_searched = to_u32(resolved_candidates.len());

		let mut all_matches = Vec::new();
		let mut parse_errors = Vec::new();
		let mut total_matches = 0u32;
		let mut files_with_matches = BTreeSet::new();
		for resolved in resolved_candidates {
			ct.heartbeat()?;
			let ResolvedCandidate { candidate, language, language_error } = resolved;

			if let Some(error) = language_error.as_deref() {
				for compiled in &compiled_patterns {
					parse_errors
						.push(format!("{}: {}: {error}", compiled.pattern, candidate.display_path));
				}
				continue;
			}

			let Some(language) = language else {
				continue;
			};
			let lang_key = language.canonical_name();
			let source = match std::fs::read_to_string(&candidate.absolute_path) {
				Ok(source) => source,
				Err(err) => {
					for compiled in &compiled_patterns {
						parse_errors
							.push(format!("{}: {}: {err}", compiled.pattern, candidate.display_path));
					}
					continue;
				},
			};

			let mut runnable_patterns: Vec<(&str, &Pattern)> = Vec::new();
			for compiled in &compiled_patterns {
				ct.heartbeat()?;
				if let Some(error) = compiled.compile_errors_by_lang.get(lang_key) {
					parse_errors
						.push(format!("{}: {}: {error}", compiled.pattern, candidate.display_path));
					continue;
				}
				if let Some(pattern) = compiled.compiled_by_lang.get(lang_key) {
					runnable_patterns.push((compiled.pattern.as_str(), pattern));
				}
			}
			if runnable_patterns.is_empty() {
				continue;
			}

			let ast = language.ast_grep(source);
			if ast.root().dfs().any(|node| node.is_error()) {
				parse_errors.push(format!(
					"{}: parse error (syntax tree contains error nodes)",
					candidate.display_path
				));
			}

			for (_, pattern) in runnable_patterns {
				ct.heartbeat()?;
				for matched in ast.root().find_all(pattern.clone()) {
					ct.heartbeat()?;
					total_matches = total_matches.saturating_add(1);
					let range = matched.range();
					let start = matched.start_pos();
					let end = matched.end_pos();
					let meta_variables = if include_meta {
						Some(HashMap::<String, String>::from(matched.get_env().clone()))
					} else {
						None
					};
					all_matches.push(AstFindMatch {
						path: candidate.display_path.clone(),
						text: matched.text().into_owned(),
						byte_start: to_u32(range.start),
						byte_end: to_u32(range.end),
						start_line: to_u32(start.line().saturating_add(1)),
						start_column: to_u32(start.column(matched.get_node()).saturating_add(1)),
						end_line: to_u32(end.line().saturating_add(1)),
						end_column: to_u32(end.column(matched.get_node()).saturating_add(1)),
						meta_variables,
					});
					files_with_matches.insert(candidate.display_path.clone());
				}
			}
		}

		all_matches.sort_by(|left, right| {
			left
				.path
				.cmp(&right.path)
				.then(left.start_line.cmp(&right.start_line))
				.then(left.start_column.cmp(&right.start_column))
				.then(left.end_line.cmp(&right.end_line))
				.then(left.end_column.cmp(&right.end_column))
				.then(left.byte_start.cmp(&right.byte_start))
				.then(left.byte_end.cmp(&right.byte_end))
		});

		let visible_matches = all_matches
			.into_iter()
			.skip(normalized_offset as usize)
			.collect::<Vec<_>>();
		let limit_reached = visible_matches.len() > normalized_limit as usize;
		let matches = visible_matches
			.into_iter()
			.take(normalized_limit as usize)
			.collect::<Vec<_>>();

		Ok(AstFindResult {
			matches,
			total_matches,
			files_with_matches: to_u32(files_with_matches.len()),
			files_searched,
			limit_reached,
			parse_errors: (!parse_errors.is_empty()).then_some(parse_errors),
		})
	})
}

/// Apply ast-grep rewrite rules to matching files; honors `dryRun` and returns
/// a promise.
#[napi]
pub fn ast_edit(options: AstReplaceOptions<'_>) -> task::Promise<AstReplaceResult> {
	let AstReplaceOptions {
		rewrites,
		lang,
		path,
		glob,
		selector,
		strictness,
		dry_run,
		max_replacements,
		max_files,
		fail_on_parse_error,
		signal,
		timeout_ms,
	} = options;

	let ct = task::CancelToken::new(timeout_ms, signal);
	task::blocking("ast_edit", ct, move |ct| {
		let rewrite_rules = normalize_rewrite_map(rewrites)?;
		let strictness = resolve_strictness(strictness);
		let dry_run = dry_run.unwrap_or(true);
		let max_replacements = max_replacements.unwrap_or(u32::MAX).max(1);
		let max_files = max_files.unwrap_or(u32::MAX).max(1);
		let fail_on_parse_error = fail_on_parse_error.unwrap_or(false);

		let lang_str = lang.as_deref().map(str::trim).filter(|v| !v.is_empty());
		if let Some(lang) = lang_str {
			resolve_supported_lang(lang)?;
		}
		let candidates: Vec<_> = collect_candidates(path, glob.as_deref(), &ct)?
			.into_iter()
			.filter(|candidate| is_supported_file(&candidate.absolute_path, lang_str))
			.collect();
		let effective_lang = if let Some(lang) = lang_str {
			lang.to_string()
		} else {
			infer_single_replace_lang(&candidates, &ct)?
		};

		let language = resolve_supported_lang(&effective_lang)?;
		let mut parse_errors = Vec::new();
		let mut compiled_rules = Vec::new();
		for (pattern, rewrite) in rewrite_rules {
			ct.heartbeat()?;
			match compile_pattern(&pattern, selector.as_deref(), &strictness, language) {
				Ok(compiled) => compiled_rules.push((pattern, rewrite, compiled)),
				Err(err) => {
					if fail_on_parse_error {
						return Err(err);
					}
					parse_errors.push(format!("{pattern}: {err}"));
				},
			}
		}
		if compiled_rules.is_empty() {
			return Ok(AstReplaceResult {
				file_changes: vec![],
				total_replacements: 0,
				files_touched: 0,
				files_searched: to_u32(candidates.len()),
				applied: !dry_run,
				limit_reached: false,
				parse_errors: (!parse_errors.is_empty()).then_some(parse_errors),
				changes: vec![],
			});
		}

		let mut changes = Vec::new();
		let mut file_counts: BTreeMap<String, u32> = BTreeMap::new();
		let mut files_touched = 0u32;
		let mut limit_reached = false;

		for candidate in &candidates {
			ct.heartbeat()?;
			let source = match std::fs::read_to_string(&candidate.absolute_path) {
				Ok(source) => source,
				Err(err) => {
					if fail_on_parse_error {
						return Err(Error::from_reason(format!("{}: {err}", candidate.display_path)));
					}
					parse_errors.push(format!("{}: {err}", candidate.display_path));
					continue;
				},
			};

			let ast = language.ast_grep(&source);
			if ast.root().dfs().any(|node| node.is_error()) {
				let parse_issue = format!(
					"{}: parse error (syntax tree contains error nodes)",
					candidate.display_path
				);
				if fail_on_parse_error {
					return Err(Error::from_reason(parse_issue));
				}
				parse_errors.push(parse_issue);
				continue;
			}

			let mut file_changes = Vec::new();
			let mut reached_max_replacements = false;
			'patterns: for (_pattern, rewrite, compiled) in &compiled_rules {
				for matched in ast.root().find_all(compiled.clone()) {
					ct.heartbeat()?;
					if changes.len() + file_changes.len() >= max_replacements as usize {
						limit_reached = true;
						reached_max_replacements = true;
						break 'patterns;
					}
					let edit = matched.replace_by(rewrite.as_str());
					let range = matched.range();
					let start = matched.start_pos();
					let end = matched.end_pos();
					let after = String::from_utf8(edit.inserted_text.clone()).map_err(|err| {
						Error::from_reason(format!(
							"{}: replacement text is not valid UTF-8: {err}",
							candidate.display_path
						))
					})?;
					file_changes.push(PendingFileChange {
						change: AstReplaceChange {
							path: candidate.display_path.clone(),
							before: matched.text().into_owned(),
							after,
							byte_start: to_u32(range.start),
							byte_end: to_u32(range.end),
							deleted_length: to_u32(edit.deleted_length),
							start_line: to_u32(start.line().saturating_add(1)),
							start_column: to_u32(start.column(matched.get_node()).saturating_add(1)),
							end_line: to_u32(end.line().saturating_add(1)),
							end_column: to_u32(end.column(matched.get_node()).saturating_add(1)),
						},
						edit,
					});
				}
			}

			if file_changes.is_empty() {
				if reached_max_replacements {
					break;
				}
				continue;
			}
			if files_touched >= max_files {
				limit_reached = true;
				break;
			}
			files_touched = files_touched.saturating_add(1);
			file_counts.insert(candidate.display_path.clone(), to_u32(file_changes.len()));

			if !dry_run {
				let edits: Vec<Edit<String>> = file_changes
					.iter()
					.map(|entry| Edit {
						position: entry.edit.position,
						deleted_length: entry.edit.deleted_length,
						inserted_text: entry.edit.inserted_text.clone(),
					})
					.collect();
				let output = apply_edits(&source, &edits)?;
				if output != source {
					std::fs::write(&candidate.absolute_path, output).map_err(|err| {
						Error::from_reason(format!("Failed to write {}: {err}", candidate.display_path))
					})?;
				}
			}

			changes.extend(file_changes.into_iter().map(|entry| entry.change));
			if reached_max_replacements {
				break;
			}
		}

		let file_changes = file_counts
			.into_iter()
			.map(|(path, count)| AstReplaceFileChange { path, count })
			.collect::<Vec<_>>();

		Ok(AstReplaceResult {
			file_changes,
			total_replacements: to_u32(changes.len()),
			files_touched,
			files_searched: to_u32(candidates.len()),
			applied: !dry_run,
			limit_reached,
			parse_errors: (!parse_errors.is_empty()).then_some(parse_errors),
			changes,
		})
	})
}

#[cfg(test)]
mod tests {
	use std::{
		fs,
		path::PathBuf,
		time::{SystemTime, UNIX_EPOCH},
	};

	use super::*;

	struct TempTree {
		root: PathBuf,
	}

	impl Drop for TempTree {
		fn drop(&mut self) {
			let _ = fs::remove_dir_all(&self.root);
		}
	}

	fn make_temp_tree() -> TempTree {
		let unique = SystemTime::now()
			.duration_since(UNIX_EPOCH)
			.expect("system time should be after UNIX_EPOCH")
			.as_nanos();
		let root = std::env::temp_dir().join(format!("pi-ast-glob-test-{unique}"));
		fs::create_dir_all(root.join("nested")).expect("temp nested dir should be created");
		fs::write(root.join("a.ts"), "const a = 1;\n").expect("temp file a.ts should be written");
		fs::write(root.join("nested").join("b.ts"), "const b = 2;\n")
			.expect("temp file nested/b.ts should be written");
		TempTree { root }
	}

	#[test]
	fn glob_star_matches_only_direct_children() {
		let tree = make_temp_tree();
		let ct = task::CancelToken::default();
		let candidates =
			collect_candidates(Some(tree.root.to_string_lossy().into_owned()), Some("*.ts"), &ct)
				.expect("candidate collection should succeed");
		let paths = candidates
			.into_iter()
			.map(|file| file.display_path)
			.collect::<Vec<_>>();
		assert_eq!(paths, vec!["a.ts".to_string()]);
	}

	#[test]
	fn glob_double_star_matches_recursively() {
		let tree = make_temp_tree();
		let ct = task::CancelToken::default();
		let candidates =
			collect_candidates(Some(tree.root.to_string_lossy().into_owned()), Some("**/*.ts"), &ct)
				.expect("candidate collection should succeed");
		let paths = candidates
			.into_iter()
			.map(|file| file.display_path)
			.collect::<Vec<_>>();
		assert_eq!(paths, vec!["a.ts".to_string(), "nested/b.ts".to_string()]);
	}
	fn make_mixed_temp_tree() -> TempTree {
		let unique = SystemTime::now()
			.duration_since(UNIX_EPOCH)
			.expect("system time should be after UNIX_EPOCH")
			.as_nanos();
		let root = std::env::temp_dir().join(format!("pi-ast-mixed-lang-test-{unique}"));
		fs::create_dir_all(&root).expect("temp mixed-lang dir should be created");
		fs::write(root.join("a.ts"), "const a = 1;\n").expect("temp file a.ts should be written");
		fs::write(root.join("b.rs"), "fn main() {}\n").expect("temp file b.rs should be written");
		TempTree { root }
	}

	#[test]
	fn infers_single_replace_lang_for_uniform_candidates() {
		let tree = make_temp_tree();
		let ct = task::CancelToken::default();
		let candidates =
			collect_candidates(Some(tree.root.to_string_lossy().into_owned()), Some("**/*.ts"), &ct)
				.expect("candidate collection should succeed");
		let inferred =
			infer_single_replace_lang(&candidates, &ct).expect("language should be inferred");
		assert_eq!(inferred, "typescript");
	}

	#[test]
	fn rejects_mixed_replace_lang_inference() {
		let tree = make_mixed_temp_tree();
		let ct = task::CancelToken::default();
		let candidates =
			collect_candidates(Some(tree.root.to_string_lossy().into_owned()), None, &ct)
				.expect("candidate collection should succeed");
		let err = infer_single_replace_lang(&candidates, &ct)
			.expect_err("mixed language inference should fail");
		assert!(err.to_string().contains("multiple languages"));
	}
	#[test]
	fn resolves_supported_language_aliases() {
		assert_eq!(resolve_supported_lang("ts").ok(), Some(SupportLang::TypeScript));
		assert_eq!(resolve_supported_lang("jsx").ok(), Some(SupportLang::JavaScript));
		assert_eq!(resolve_supported_lang("rs").ok(), Some(SupportLang::Rust));
		#[cfg(feature = "full-langs")]
		{
			assert_eq!(resolve_supported_lang("kotlin").ok(), Some(SupportLang::Kotlin));
			assert_eq!(resolve_supported_lang("tla").ok(), Some(SupportLang::Tlaplus));
			assert_eq!(resolve_supported_lang("pluscal").ok(), Some(SupportLang::Tlaplus));
		}
		#[cfg(not(feature = "full-langs"))]
		{
			let err = resolve_supported_lang("kotlin").expect_err("kotlin should require full-langs");
			assert!(err.to_string().contains("full-langs"));
		}
		assert_eq!(resolve_supported_lang("bash").ok(), Some(SupportLang::Bash));
		assert_eq!(resolve_supported_lang("c").ok(), Some(SupportLang::C));
		assert_eq!(resolve_supported_lang("cpp").ok(), Some(SupportLang::Cpp));
		assert!(resolve_supported_lang("brainfuck").is_err());
	}

	#[test]
	fn applies_non_overlapping_edits() {
		let source = "const answer = 41;";
		let edits = vec![
			Edit::<String> { position: 6, deleted_length: 6, inserted_text: b"value".to_vec() },
			Edit::<String> { position: 15, deleted_length: 2, inserted_text: b"42".to_vec() },
		];
		let output = apply_edits(source, &edits).expect("edits should apply");
		assert_eq!(output, "const value = 42;");
	}

	#[test]
	fn rejects_overlapping_edits() {
		let source = "abcdef";
		let edits = vec![
			Edit::<String> { position: 1, deleted_length: 3, inserted_text: b"x".to_vec() },
			Edit::<String> { position: 2, deleted_length: 1, inserted_text: b"y".to_vec() },
		];
		assert!(apply_edits(source, &edits).is_err());
	}
}
