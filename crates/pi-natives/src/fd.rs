// Source: oh-my-pi `crates/pi-natives/src/fd.rs`
// Pinned revision: a85bd5228d9f0f619deade1db78fa49420a721e1 (MIT).
// Gajae-Code modifications: retain NFC/Hangul scoring and use pi-walker
// traversal.
//! Fuzzy file path discovery for autocomplete and @-mention resolution.
//!
//! Searches for files and directories whose paths match a query string via
//! subsequence scoring. Uses `pi-walker` for directory traversal and caching.

use std::{borrow::Cow, cmp::Ordering, collections::BinaryHeap, path::Path};

use napi::bindgen_prelude::*;
use napi_derive::napi;
use pi_vfs::BlockingFs;
use unicode_normalization::{IsNormalized, UnicodeNormalization, is_nfc_quick};

use crate::{iofs, task};

/// Options for fuzzy file path search.
#[napi(object)]
pub struct FuzzyFindOptions<'env> {
	/// Fuzzy query to match against file paths (case-insensitive).
	pub query:       String,
	/// Directory to search.
	pub path:        String,
	/// Include hidden files (default: false).
	pub hidden:      Option<bool>,
	/// Respect .gitignore (default: true).
	pub gitignore:   Option<bool>,
	/// Enable the pi-walker shared scan cache (default: false).
	pub cache:       Option<bool>,
	/// Maximum number of matches to return (default: 100).
	pub max_results: Option<u32>,
	/// Abort signal for cancelling the operation.
	pub signal:      Option<Unknown<'env>>,
	/// Timeout in milliseconds for the operation.
	pub timeout_ms:  Option<u32>,
}

/// A single match in fuzzy find results.
#[napi(object)]
pub struct FuzzyFindMatch {
	/// Relative path from the search root (uses `/` separators).
	pub path:         String,
	/// Whether this entry is a directory.
	pub is_directory: bool,
	/// Match quality score (higher is better).
	pub score:        u32,
}

/// Result of fuzzy file path search.
#[napi(object)]
pub struct FuzzyFindResult {
	/// Matched entries (up to `maxResults`).
	pub matches:       Vec<FuzzyFindMatch>,
	/// Total number of matches found (may exceed `matches.len()`).
	pub total_matches: u32,
}

/// Composes decomposed (NFD) file names, e.g. from macOS APFS/HFS+ volumes, so
/// they match composed (NFC) queries typed in the composer.
fn nfc_normalize(value: &str) -> Cow<'_, str> {
	match is_nfc_quick(value.chars()) {
		IsNormalized::Yes => Cow::Borrowed(value),
		_ => Cow::Owned(value.nfc().collect()),
	}
}

fn normalize_fuzzy_text(value: &str) -> String {
	nfc_normalize(value)
		.chars()
		.filter(|ch| !ch.is_whitespace() && !matches!(ch, '/' | '\\' | '.' | '_' | '-'))
		.flat_map(|ch| ch.to_lowercase())
		.collect()
}

const HANGUL_SYLLABLE_BASE: u32 = 0xac00;
const HANGUL_SYLLABLE_COUNT: u32 = 11_172;
const SYLLABLES_PER_INITIAL: u32 = 588;

/// Keyboard-typed compatibility jamo (U+3131 block) for each of the 19
/// Hangul initial consonants, indexed by a syllable's initial-consonant index.
const INITIAL_COMPAT_JAMO: [char; 19] = [
	'ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ',
	'ㅌ', 'ㅍ', 'ㅎ',
];

fn hangul_initial_jamo(ch: char) -> Option<char> {
	let offset = (ch as u32).checked_sub(HANGUL_SYLLABLE_BASE)?;
	if offset >= HANGUL_SYLLABLE_COUNT {
		return None;
	}
	Some(INITIAL_COMPAT_JAMO[(offset / SYLLABLES_PER_INITIAL) as usize])
}

/// A query char matches a target char literally, or — when the query char is a
/// bare consonant jamo — by the target syllable's initial consonant (초성
/// 검색).
#[allow(
	clippy::suspicious_operation_groupings,
	reason = "the asymmetry is intended: a bare jamo query char matches the target syllable's \
	          initial"
)]
fn fuzzy_char_matches(query_ch: char, target_ch: char) -> bool {
	query_ch == target_ch || hangul_initial_jamo(target_ch) == Some(query_ch)
}

fn fuzzy_subsequence_score(query_chars: &[char], target: &str) -> u32 {
	if query_chars.is_empty() {
		return 1;
	}
	let mut query_index = 0usize;
	let mut gaps = 0u32;
	let mut last_match_index: Option<usize> = None;
	for (target_index, target_ch) in target.chars().enumerate() {
		if query_index >= query_chars.len() {
			break;
		}
		if fuzzy_char_matches(query_chars[query_index], target_ch) {
			if let Some(last_index) = last_match_index
				&& target_index > last_index + 1
			{
				gaps = gaps.saturating_add(1);
			}
			last_match_index = Some(target_index);
			query_index += 1;
		}
	}
	if query_index != query_chars.len() {
		return 0;
	}
	let gap_penalty = gaps.saturating_mul(5);
	40u32.saturating_sub(gap_penalty).max(1)
}

fn score_fuzzy_path(
	path: &str,
	is_directory: bool,
	query_lower: &str,
	normalized_query: &str,
	query_chars: &[char],
) -> u32 {
	if query_lower.is_empty() {
		return if is_directory { 11 } else { 1 };
	}

	// Match against the full relative path only when the user typed a path-style
	// query (contains a path separator). Plain queries should match by basename
	// only, otherwise '@plan' surfaces every file whose ancestor directories
	// contain 'plan'.
	let query_has_slash = query_lower.contains('/') || query_lower.contains('\\');

	let file_name = Path::new(path)
		.file_name()
		.and_then(|name| name.to_str())
		.unwrap_or(path);
	let lower_file_name = nfc_normalize(file_name).to_lowercase();

	let mut score = if lower_file_name == query_lower {
		120
	} else if lower_file_name.starts_with(query_lower) {
		100
	} else if lower_file_name.contains(query_lower) {
		80
	} else if !query_has_slash {
		let normalized_file_name = normalize_fuzzy_text(file_name);
		let file_name_fuzzy = fuzzy_subsequence_score(query_chars, &normalized_file_name);
		if file_name_fuzzy > 0 {
			50 + file_name_fuzzy
		} else {
			0
		}
	} else {
		let lower_path = nfc_normalize(path).to_lowercase();
		if lower_path.contains(query_lower) {
			60
		} else {
			let normalized_file_name = normalize_fuzzy_text(file_name);
			let file_name_fuzzy = fuzzy_subsequence_score(query_chars, &normalized_file_name);
			if file_name_fuzzy > 0 {
				50 + file_name_fuzzy
			} else {
				let normalized_path = normalize_fuzzy_text(path);
				let path_fuzzy = if normalized_path == normalized_query {
					40
				} else {
					fuzzy_subsequence_score(query_chars, &normalized_path)
				};
				if path_fuzzy > 0 { 30 + path_fuzzy } else { 0 }
			}
		}
	};

	if is_directory && score > 0 {
		score += 10;
	}

	score
}

struct FuzzyFindConfig {
	query:       String,
	path:        String,
	hidden:      Option<bool>,
	gitignore:   Option<bool>,
	max_results: Option<u32>,
	cache:       Option<bool>,
}

/// A scored match retained by [`TopMatches`], ordered worst-first.
struct RankedMatch {
	entry: FuzzyFindMatch,
}

impl Ord for RankedMatch {
	fn cmp(&self, other: &Self) -> Ordering {
		other
			.entry
			.score
			.cmp(&self.entry.score)
			.then_with(|| self.entry.path.cmp(&other.entry.path))
	}
}

impl PartialOrd for RankedMatch {
	fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
		Some(self.cmp(other))
	}
}

impl PartialEq for RankedMatch {
	fn eq(&self, other: &Self) -> bool {
		self.cmp(other) == Ordering::Equal
	}
}

impl Eq for RankedMatch {}

/// Bounded collector retaining the best matches while counting every hit.
struct TopMatches {
	capacity: usize,
	total:    u64,
	heap:     BinaryHeap<RankedMatch>,
}

impl TopMatches {
	fn new(capacity: usize) -> Self {
		Self { capacity, total: 0, heap: BinaryHeap::with_capacity(capacity.min(256)) }
	}

	fn push(&mut self, entry: FuzzyFindMatch) {
		self.total = self.total.saturating_add(1);
		if self.capacity == 0 {
			return;
		}
		let candidate = RankedMatch { entry };
		if self.heap.len() < self.capacity {
			self.heap.push(candidate);
			return;
		}
		if self.heap.peek().is_some_and(|worst| candidate < *worst) {
			self.heap.pop();
			self.heap.push(candidate);
		}
	}

	const fn total_matches(&self) -> u32 {
		crate::utils::clamp_u32(self.total)
	}

	fn into_sorted_matches(self) -> Vec<FuzzyFindMatch> {
		self
			.heap
			.into_sorted_vec()
			.into_iter()
			.map(|ranked| ranked.entry)
			.collect()
	}
}

fn score_entries<I>(
	entries: I,
	query_lower: &str,
	normalized_query: &str,
	query_chars: &[char],
	max_results: usize,
	ct: &task::CancelToken,
) -> Result<TopMatches>
where
	I: IntoIterator<Item = iofs::GlobMatch>,
{
	let mut scored = TopMatches::new(max_results);
	for entry in entries {
		ct.heartbeat()?;
		if entry.file_type == iofs::FileType::Symlink {
			continue;
		}

		let is_directory = entry.file_type == iofs::FileType::Dir;
		let score =
			score_fuzzy_path(&entry.path, is_directory, query_lower, normalized_query, query_chars);
		if score == 0 {
			continue;
		}

		let mut path = entry.path;
		if is_directory {
			path.push('/');
		}
		scored.push(FuzzyFindMatch { path, is_directory, score });
	}
	Ok(scored)
}

fn fuzzy_find_sync(config: FuzzyFindConfig, ct: task::CancelToken) -> Result<FuzzyFindResult> {
	fuzzy_find_sync_with_fs(config, BlockingFs::native(), ct)
}

fn fuzzy_find_sync_with_fs(
	config: FuzzyFindConfig,
	fs: BlockingFs,
	ct: task::CancelToken,
) -> Result<FuzzyFindResult> {
	let root = iofs::resolve_search_dir(&fs, &config.path)?;
	let include_hidden = config.hidden.unwrap_or(false);
	let respect_gitignore = config.gitignore.unwrap_or(true);
	let max_results = config.max_results.unwrap_or(100) as usize;
	if max_results == 0 {
		return Ok(FuzzyFindResult { matches: Vec::new(), total_matches: 0 });
	}

	let query_lower = nfc_normalize(config.query.trim())
		.to_lowercase()
		.replace('\\', "/");
	let normalized_query = normalize_fuzzy_text(&query_lower);
	let query_chars: Vec<char> = normalized_query.chars().collect();
	if !query_lower.is_empty() && normalized_query.is_empty() {
		return Ok(FuzzyFindResult { matches: Vec::new(), total_matches: 0 });
	}

	let use_cache = config.cache.unwrap_or(false);
	let request = pi_walker::WalkRequest::new(root)
		.filesystem(fs)
		.hidden(include_hidden)
		.gitignore(respect_gitignore)
		.skip_git(true)
		.skip_node_modules(true)
		.follow_links(pi_walker::FollowLinks::Always)
		.detail(pi_walker::WalkDetail::Minimal)
		.order(pi_walker::WalkOrder::Path)
		.emit_root(false)
		.depth(1, usize::MAX)
		.directory_errors(pi_walker::DirectoryErrorMode::SkipSkippable)
		.cache(use_cache)
		.empty_recheck(pi_walker::EmptyRecheck::Configured);
	let outcome = request
		.collect_with_heartbeat(|| ct.heartbeat())
		.map_err(iofs::map_walker_error)?;
	let cache_age_ms = outcome.stats.cache_age_ms;
	let mut scored = score_entries(
		outcome.entries.into_iter().map(iofs::GlobMatch::from),
		&query_lower,
		&normalized_query,
		&query_chars,
		max_results,
		&ct,
	)?;
	let empty_recheck_ms = pi_walker::empty_recheck_ms();
	if use_cache
		&& !query_lower.is_empty()
		&& scored.total_matches() == 0
		&& empty_recheck_ms > 0
		&& cache_age_ms >= empty_recheck_ms
	{
		let fresh = request
			.clone()
			.cache(false)
			.collect_with_heartbeat(|| ct.heartbeat())
			.map_err(iofs::map_walker_error)?;
		scored = score_entries(
			fresh.entries.into_iter().map(iofs::GlobMatch::from),
			&query_lower,
			&normalized_query,
			&query_chars,
			max_results,
			&ct,
		)?;
	}

	let total_matches = scored.total_matches();
	let matches = scored.into_sorted_matches();
	Ok(FuzzyFindResult { matches, total_matches })
}

/// Fuzzy file path search for autocomplete.
#[napi(js_name = "fuzzyFind")]
pub fn fuzzy_find(options: FuzzyFindOptions<'_>) -> task::Promise<FuzzyFindResult> {
	let FuzzyFindOptions { query, path, hidden, gitignore, cache, max_results, timeout_ms, signal } =
		options;
	let ct = task::CancelToken::new(timeout_ms, signal);
	let config = FuzzyFindConfig { query, path, hidden, gitignore, max_results, cache };
	task::blocking("fuzzy_find", ct, move |ct| fuzzy_find_sync(config, ct))
}

#[cfg(test)]
mod tests {
	use super::*;

	fn score(path: &str, query: &str) -> u32 {
		let query_lower = nfc_normalize(query.trim())
			.to_lowercase()
			.replace('\\', "/");
		let normalized_query = normalize_fuzzy_text(&query_lower);
		let query_chars: Vec<char> = normalized_query.chars().collect();
		score_fuzzy_path(path, false, &query_lower, &normalized_query, &query_chars)
	}

	#[test]
	fn nfc_query_matches_nfd_file_name() {
		let nfd = "\u{1112}\u{1161}\u{11AB}\u{1100}\u{1173}\u{11AF}.txt";
		assert!(score(nfd, "\u{D55C}") > 0);
		assert!(score(nfd, "\u{D55C}\u{AE00}") > 0);
	}

	#[test]
	fn nfd_query_matches_nfc_file_name() {
		assert!(score("\u{D55C}\u{AE00}.txt", "\u{1112}\u{1161}\u{11AB}") > 0);
	}

	#[test]
	fn nfc_query_matches_nfd_path_segment() {
		let nfd_dir = "\u{1103}\u{1169}\u{11A8}\u{1109}\u{1165}/readme.md";
		assert!(score(nfd_dir, "\u{B3C5}\u{C11C}/read") > 0);
	}

	#[test]
	fn windows_separator_query_matches_forward_slash_path() {
		assert!(score("src/readme.md", "src\\read") > 0);
	}

	#[test]
	fn ascii_scoring_is_unchanged() {
		assert_eq!(score("readme.md", "readme.md"), 120);
		assert_eq!(score("readme.md", "read"), 100);
		assert_eq!(score("readme.md", "zzz"), 0);
	}

	#[test]
	fn nfc_normalize_borrows_composed_text() {
		assert!(matches!(nfc_normalize("plain/ascii.txt"), Cow::Borrowed(_)));
	}

	#[test]
	fn chosung_query_matches_syllable_initials() {
		assert_eq!(score("\u{D55C}\u{AE00}.txt", "\u{314E}\u{3131}"), 90);
	}

	#[test]
	fn chosung_query_matches_nfd_file_name() {
		let nfd = "\u{1112}\u{1161}\u{11AB}\u{1100}\u{1173}\u{11AF}.txt";
		assert_eq!(score(nfd, "\u{314E}\u{3131}"), 90);
	}

	#[test]
	fn chosung_mixed_with_full_syllables() {
		assert_eq!(score("\u{D55C}\u{AE00}.txt", "\u{314E}\u{AE00}"), 90);
		assert_eq!(score("\u{D55C}\u{AE00}.txt", "\u{D55C}\u{3131}"), 90);
	}

	#[test]
	fn chosung_double_consonants() {
		assert!(score("\u{B538}\u{AE30}.txt", "\u{3138}\u{3131}") > 0);
		assert!(score("\u{C4F0}\u{AE30}.md", "\u{3146}") > 0);
	}

	#[test]
	fn chosung_requires_subsequence_order() {
		assert_eq!(score("\u{D55C}\u{AE00}.txt", "\u{3131}\u{314E}"), 0);
	}

	#[test]
	fn chosung_rejects_absent_initials() {
		assert_eq!(score("\u{D55C}\u{AE00}.txt", "\u{3134}"), 0);
	}

	#[test]
	fn chosung_covers_syllable_block_boundaries() {
		assert!(score("\u{AC00}.txt", "\u{3131}") > 0);
		assert!(score("\u{D7A3}.txt", "\u{314E}") > 0);
	}

	#[test]
	fn vowel_jamo_only_matches_literally() {
		assert_eq!(score("\u{D55C}\u{AE00}.txt", "\u{314F}"), 0);
		assert!(score("\u{314F}note.txt", "\u{314F}") > 0);
	}

	#[test]
	fn literal_jamo_file_name_outranks_chosung_match() {
		let literal = score("\u{314E}\u{3131}.txt", "\u{314E}\u{3131}");
		let chosung = score("\u{D55C}\u{AE00}.txt", "\u{314E}\u{3131}");
		assert_eq!(literal, 100);
		assert!(literal > chosung);
	}

	#[test]
	fn chosung_matches_path_segments_for_path_queries() {
		assert!(score("\u{D55C}\u{AE00}/readme.md", "\u{314E}\u{3131}/read") > 0);
		assert_eq!(score("\u{D55C}\u{AE00}/readme.md", "\u{314E}\u{3131}"), 0);
	}

	#[test]
	fn chosung_gap_penalty_prefers_adjacent_matches() {
		let adjacent = score("\u{D55C}\u{AE00}\u{BAA8}\u{C74C}.txt", "\u{314E}\u{3131}");
		let gapped = score("\u{D55C}\u{AE00}\u{BAA8}\u{C74C}.txt", "\u{314E}\u{BAA8}");
		assert!(adjacent > gapped);
		assert!(gapped > 0);
	}

	#[test]
	fn hangul_initial_jamo_maps_all_nineteen_initials() {
		for (index, jamo) in INITIAL_COMPAT_JAMO.iter().enumerate() {
			let syllable =
				char::from_u32(HANGUL_SYLLABLE_BASE + index as u32 * SYLLABLES_PER_INITIAL).unwrap();
			assert_eq!(hangul_initial_jamo(syllable), Some(*jamo));
		}
		assert_eq!(hangul_initial_jamo('a'), None);
		assert_eq!(hangul_initial_jamo('\u{314E}'), None);
		assert_eq!(hangul_initial_jamo('\u{1112}'), None);
	}
}

#[cfg(test)]
mod walker_tests {
	use super::*;
	#[test]
	fn bounded_retention_preserves_score_then_lexical_path_order() {
		let candidates = [
			("z/nested.txt", false, 100),
			("a/nested.txt", false, 100),
			("root.txt", false, 100),
			("needle-dir/", true, 110),
		];
		let mut expected: Vec<(String, bool, u32)> = candidates
			.iter()
			.map(|(path, is_directory, score)| (path.to_string(), *is_directory, *score))
			.collect();
		expected.sort_by(|left, right| right.2.cmp(&left.2).then_with(|| left.0.cmp(&right.0)));

		for capacity in 0..=candidates.len() + 1 {
			let mut bounded = TopMatches::new(capacity);
			for (path, is_directory, score) in &expected {
				bounded.push(FuzzyFindMatch {
					path:         path.clone(),
					is_directory: *is_directory,
					score:        *score,
				});
			}
			assert_eq!(bounded.total_matches(), candidates.len() as u32);
			let actual: Vec<_> = bounded
				.into_sorted_matches()
				.into_iter()
				.map(|entry| (entry.path, entry.is_directory, entry.score))
				.collect();
			assert_eq!(actual, expected.iter().take(capacity).cloned().collect::<Vec<_>>());
		}
	}

	#[test]
	fn fuzzy_find_walks_virtual_filesystems() {
		use crate::testing::MemFs;

		let (_mem, fs) = MemFs::with_files(&[
			("mem://fuzzy/readme-needle.txt", "readme"),
			("mem://fuzzy/nested/needle-file.txt", "needle"),
		]);
		let result = fuzzy_find_sync_with_fs(
			FuzzyFindConfig {
				query:       "needle".to_owned(),
				path:        "mem://fuzzy".to_owned(),
				hidden:      Some(true),
				gitignore:   Some(false),
				max_results: Some(8),
				cache:       Some(false),
			},
			fs,
			crate::task::CancelToken::default(),
		)
		.expect("virtual filesystem search succeeds");

		assert_eq!(result.total_matches, 2);
		assert_eq!(
			result
				.matches
				.iter()
				.map(|entry| entry.path.as_str())
				.collect::<Vec<_>>(),
			["nested/needle-file.txt", "readme-needle.txt"]
		);
	}

	#[cfg(unix)]
	mod native_filesystem_tests {
		use std::{
			fs,
			os::unix::fs as unix_fs,
			path::{Path, PathBuf},
			sync::atomic::{AtomicU64, Ordering},
			time::{Duration, SystemTime, UNIX_EPOCH},
		};

		use super::*;

		struct TempDirGuard(PathBuf);

		impl TempDirGuard {
			fn new() -> Self {
				static COUNTER: AtomicU64 = AtomicU64::new(0);
				let timestamp = SystemTime::now()
					.duration_since(UNIX_EPOCH)
					.expect("system time is after UNIX_EPOCH")
					.as_nanos();
				let counter = COUNTER.fetch_add(1, Ordering::Relaxed);
				let path = std::env::temp_dir()
					.join(format!("pi-fd-test-{}-{timestamp}-{counter}", std::process::id()));
				fs::create_dir_all(&path).expect("create temp test directory");
				Self(path)
			}

			fn path(&self) -> &Path {
				&self.0
			}
		}

		impl Drop for TempDirGuard {
			fn drop(&mut self) {
				let _ = fs::remove_dir_all(&self.0);
			}
		}

		fn config(query: &str, root: &Path, max_results: u32, cache: bool) -> FuzzyFindConfig {
			FuzzyFindConfig {
				query:       query.to_owned(),
				path:        root.to_string_lossy().into_owned(),
				hidden:      Some(true),
				gitignore:   Some(false),
				max_results: Some(max_results),
				cache:       Some(cache),
			}
		}

		#[test]
		fn fuzzy_find_follows_symlinked_directories() {
			let root = TempDirGuard::new();
			let real_dir = root.path().join("zz-real-dir");
			let link_dir = root.path().join("aa-linked-dir");
			let file_name = "follow-links-fuzzy-needle.txt";

			fs::create_dir_all(&real_dir).expect("create real directory");
			fs::write(real_dir.join(file_name), "needle\n").expect("write symlink target file");
			unix_fs::symlink(&real_dir, &link_dir).expect("create directory symlink");

			let result = fuzzy_find_sync(
				config(file_name, root.path(), 4, false),
				crate::task::CancelToken::default(),
			)
			.expect("fuzzy find succeeds");
			let linked_path = format!("aa-linked-dir/{file_name}");
			assert!(
				result.matches.iter().any(|entry| entry.path == linked_path),
				"expected fuzzy find to include symlink traversal path {linked_path:?}, got {:?}",
				result
					.matches
					.iter()
					.map(|entry| entry.path.as_str())
					.collect::<Vec<_>>()
			);
		}

		#[test]
		fn fuzzy_find_rechecks_cached_results_with_no_scoring_hits() {
			let root = TempDirGuard::new();
			fs::write(root.path().join("unrelated.txt"), "old entry")
				.expect("write initial nonmatching entry");
			let initial = fuzzy_find_sync(
				config("needle", root.path(), 10, true),
				crate::task::CancelToken::default(),
			)
			.expect("initial fuzzy scan succeeds");
			assert_eq!(initial.total_matches, 0);

			fs::write(root.path().join("needle-created-after-cache.txt"), "new entry")
				.expect("write matching entry after cache population");
			let empty_recheck_ms = pi_walker::empty_recheck_ms();
			if empty_recheck_ms == 0 || empty_recheck_ms > 10_000 {
				return;
			}
			std::thread::sleep(Duration::from_millis(empty_recheck_ms + 1));

			let refreshed = fuzzy_find_sync(
				config("needle", root.path(), 10, true),
				crate::task::CancelToken::default(),
			)
			.expect("stale no-hit fuzzy result is rechecked");
			assert_eq!(refreshed.total_matches, 1);
			assert_eq!(refreshed.matches[0].path, "needle-created-after-cache.txt");
		}
	}
}
