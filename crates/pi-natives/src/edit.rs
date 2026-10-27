use napi_derive::napi;
use pi_edit::fuzzy::{
	FindMatchOptions, FuzzyMatch, MatchOutcome, SequenceMatchStrategy, SequenceSearchResult,
};

use crate::env_uint;

env_uint! {
	// Bound native fuzzy scans even when called outside the coding-agent's file-size guard.
	static MAX_FUZZY_UNITS: usize = "PI_NATIVE_MAX_FUZZY_UNITS" or 16 * 1024 * 1024 => [0, usize::MAX];
}

#[napi(object)]
pub struct EditFuzzyMatch {
	pub actual_text: String,
	pub start_index: u32,
	pub start_line:  u32,
	pub confidence:  f64,
}

#[napi(object)]
pub struct EditFindMatchResult {
	pub matched:             Option<EditFuzzyMatch>,
	pub closest:             Option<EditFuzzyMatch>,
	pub occurrences:         Option<u32>,
	pub occurrence_lines:    Option<Vec<u32>>,
	pub occurrence_previews: Option<Vec<String>>,
	pub fuzzy_matches:       Option<u32>,
	pub dominant_fuzzy:      Option<bool>,
}

#[napi(object)]
pub struct EditSeekSequenceResult {
	pub index:         Option<u32>,
	pub confidence:    f64,
	pub match_count:   Option<u32>,
	pub match_indices: Option<Vec<u32>>,
	pub strategy:      Option<String>,
}

fn to_js_match(matched: FuzzyMatch, content: &str) -> EditFuzzyMatch {
	EditFuzzyMatch {
		actual_text: matched.actual_text,
		start_index: content[..matched.start_index].encode_utf16().count() as u32,
		start_line:  matched.start_line,
		confidence:  matched.confidence,
	}
}

fn to_js_match_result(result: MatchOutcome, content: &str) -> EditFindMatchResult {
	EditFindMatchResult {
		matched:             result.matched.map(|matched| to_js_match(matched, content)),
		closest:             result.closest.map(|matched| to_js_match(matched, content)),
		occurrences:         result.occurrences.map(|count| count as u32),
		occurrence_lines:    result.occurrence_lines,
		occurrence_previews: result.occurrence_previews,
		fuzzy_matches:       result.fuzzy_matches.map(|count| count as u32),
		dominant_fuzzy:      result.dominant_fuzzy,
	}
}

fn sequence_strategy(strategy: SequenceMatchStrategy) -> String {
	match strategy {
		SequenceMatchStrategy::Exact => "exact",
		SequenceMatchStrategy::TrimTrailing => "trim-trailing",
		SequenceMatchStrategy::Trim => "trim",
		SequenceMatchStrategy::CommentPrefix => "comment-prefix",
		SequenceMatchStrategy::Unicode => "unicode",
		SequenceMatchStrategy::Prefix => "prefix",
		SequenceMatchStrategy::Substring => "substring",
		SequenceMatchStrategy::Fuzzy => "fuzzy",
		SequenceMatchStrategy::FuzzyDominant => "fuzzy-dominant",
		SequenceMatchStrategy::Character => "character",
	}
	.to_owned()
}

fn to_js_sequence_result(result: SequenceSearchResult) -> EditSeekSequenceResult {
	EditSeekSequenceResult {
		index:         result.index.map(|index| index as u32),
		confidence:    result.confidence,
		match_count:   result.match_count.map(|count| count as u32),
		match_indices: result
			.match_indices
			.map(|indices| indices.into_iter().map(|index| index as u32).collect()),
		strategy:      result.strategy.map(sequence_strategy),
	}
}

fn over_fuzzy_budget(content: &str, target: &str) -> bool {
	content.encode_utf16().count() > *MAX_FUZZY_UNITS
		|| target.encode_utf16().count() > *MAX_FUZZY_UNITS
}

#[napi]
pub fn edit_find_match(
	content: String,
	target: String,
	allow_fuzzy: bool,
	threshold: Option<f64>,
) -> EditFindMatchResult {
	if over_fuzzy_budget(&content, &target) {
		return to_js_match_result(MatchOutcome::default(), &content);
	}
	let result = pi_edit::fuzzy::find_match(&content, &target, &FindMatchOptions {
		allow_fuzzy,
		threshold,
		excluded_ranges: &[],
	});
	to_js_match_result(result, &content)
}

#[napi]
pub fn edit_seek_sequence(
	lines: Vec<String>,
	pattern: Vec<String>,
	start: u32,
	eof: bool,
	allow_fuzzy: bool,
) -> EditSeekSequenceResult {
	let lines: Vec<&str> = lines.iter().map(String::as_str).collect();
	let pattern: Vec<&str> = pattern.iter().map(String::as_str).collect();
	let mut result =
		pi_edit::fuzzy::seek_sequence(&lines, &pattern, start as usize, eof, allow_fuzzy);
	if allow_fuzzy && result.index.is_none() {
		let (_, confidence, _) =
			pi_edit::fuzzy::find_closest_sequence_match(&lines, &pattern, Some(start as usize), eof);
		result.confidence = confidence;
	}
	to_js_sequence_result(result)
}

#[napi(object)]
pub struct EditApplyPatchEntry {
	pub path:   String,
	pub op:     String,
	pub rename: Option<String>,
	pub diff:   Option<String>,
}

#[napi(object)]
pub struct EditPatchApplyTextResult {
	pub content:  String,
	pub warnings: Vec<String>,
}

#[napi]
pub fn edit_parse_apply_patch(
	input: String,
	streaming: bool,
) -> napi::Result<Vec<EditApplyPatchEntry>> {
	let entries = if streaming {
		pi_edit::modes::apply_patch::parse_apply_patch_streaming(&input)
	} else {
		pi_edit::modes::apply_patch::parse_apply_patch(&input)
	}
	.map_err(|error| napi::Error::from_reason(error.to_string()))?;
	Ok(entries
		.into_iter()
		.map(|entry| EditApplyPatchEntry {
			path:   entry.path,
			op:     match entry.op {
				pi_edit::modes::patch::Operation::Create => "create",
				pi_edit::modes::patch::Operation::Delete => "delete",
				pi_edit::modes::patch::Operation::Update => "update",
			}
			.to_owned(),
			rename: entry.rename,
			diff:   entry.diff,
		})
		.collect())
}

#[napi]
pub fn edit_patch_apply_text(
	content: String,
	path: String,
	diff: String,
	threshold: f64,
	allow_fuzzy: bool,
) -> napi::Result<EditPatchApplyTextResult> {
	let (content, warnings) =
		pi_edit::modes::patch::apply_patch_text(&content, &path, &diff, threshold, allow_fuzzy)
			.map_err(|error| napi::Error::from_reason(error.to_string()))?;
	Ok(EditPatchApplyTextResult { content, warnings })
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn edit_find_match_projects_byte_offsets_to_utf16() {
		let result = edit_find_match("😀 intro\nfoo".to_owned(), "foo".to_owned(), false, None);
		let matched = result.matched.expect("exact match");
		assert_eq!(matched.start_index, 9);
		assert_eq!(matched.start_line, 2);
		assert_eq!(matched.actual_text, "foo");
	}

	#[test]
	fn edit_seek_sequence_preserves_match_strategy_and_indices() {
		let result = edit_seek_sequence(
			vec!["before".to_owned(), "    target".to_owned(), "after".to_owned()],
			vec!["target".to_owned()],
			0,
			false,
			true,
		);
		assert_eq!(result.index, Some(1));
		assert_eq!(result.strategy.as_deref(), Some("trim"));
	}

	#[test]
	fn edit_seek_sequence_preserves_zero_match_count() {
		let result = edit_seek_sequence(
			vec!["unrelated".to_owned()],
			vec!["missing".to_owned()],
			0,
			false,
			true,
		);
		assert_eq!(result.index, None);
		assert_eq!(result.match_count, Some(0));
		assert_eq!(result.match_indices, None);
	}
}
