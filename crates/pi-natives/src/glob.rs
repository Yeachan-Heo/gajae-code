//! Filesystem discovery with glob patterns, ignore semantics, and shared scan
//! caching.
//!
//! # Overview
//! Resolves a search root, obtains scanned entries via [`fs_cache`], applies
//! glob matching plus optional file-type filtering, and optionally streams each
//! accepted match through a callback.
//!
//! The walker always skips `.git`, and skips `node_modules` unless explicitly
//! requested.
//!
//! # Example
//! ```ignore
//! // JS: await native.glob({ pattern: "*.rs", path: "." })
//! ```

use std::{
	cmp::Ordering,
	collections::BinaryHeap,
	path::Path,
	time::{Duration, Instant},
};

use globset::GlobSet;
use napi::{
	bindgen_prelude::*,
	threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode},
};
use napi_derive::napi;

// Re-export entry types so existing `glob::FileType` / `glob::GlobMatch` paths still work.
pub use crate::fs_cache::{FileType, GlobMatch};
use crate::{fs_cache, glob_util, task};

const MAX_PROGRESS_SNAPSHOTS: usize = 32;
const DEFAULT_PROGRESS_INTERVAL_MS: u64 = 200;

/// Input options for `glob`, including traversal, filtering, and cancellation.
#[napi(object)]
pub struct GlobOptions<'env> {
	/// Glob pattern to match (e.g., "*.ts").
	pub pattern:              String,
	/// Directory to search.
	pub path:                 String,
	/// Filter by file type: "file", "dir", or "symlink". Symlinks are
	/// matched for file/dir filters based on their target type.
	pub file_type:            Option<FileType>,
	/// Match simple patterns recursively by default (`*.ts` -> recursive).
	pub recursive:            Option<bool>,
	/// Include hidden files (default: false).
	pub hidden:               Option<bool>,
	/// Maximum number of results to return.
	pub max_results:          Option<u32>,
	/// Respect .gitignore files (default: true).
	pub gitignore:            Option<bool>,
	/// Enable shared filesystem scan cache (default: false).
	pub cache:                Option<bool>,
	/// Sort results by mtime (most recent first) before applying limit.
	pub sort_by_mtime:        Option<bool>,
	/// Include `node_modules` entries when the pattern does not explicitly
	/// mention them.
	pub include_node_modules: Option<bool>,
	/// Abort signal for cancelling the operation.
	pub signal:               Option<Unknown<'env>>,
	/// Timeout in milliseconds for the operation.
	pub timeout_ms:           Option<u32>,
}

/// Result payload returned by a glob operation.
#[napi(object)]
pub struct GlobResult {
	/// Matched filesystem entries.
	pub matches:       Vec<GlobMatch>,
	/// Number of returned matches (`matches.len()`), clamped to `u32::MAX`.
	pub total_matches: u32,
}

/// Internal runtime config for a single glob execution.
struct GlobConfig {
	root:                  std::path::PathBuf,
	pattern:               String,
	recursive:             bool,
	include_hidden:        bool,
	file_type_filter:      Option<FileType>,
	max_results:           usize,
	use_gitignore:         bool,
	mentions_node_modules: bool,
	sort_by_mtime:         bool,
	use_cache:             bool,
	progress_interval:     Duration,
}

fn compare_matches(left: &GlobMatch, right: &GlobMatch) -> Ordering {
	right
		.mtime
		.unwrap_or(0.0)
		.total_cmp(&left.mtime.unwrap_or(0.0))
		.then_with(|| left.path.cmp(&right.path))
}

#[derive(Clone)]
struct RankedMatch(GlobMatch);

impl PartialEq for RankedMatch {
	fn eq(&self, other: &Self) -> bool {
		compare_matches(&self.0, &other.0) == Ordering::Equal
	}
}

impl Eq for RankedMatch {}

impl PartialOrd for RankedMatch {
	fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
		Some(self.cmp(other))
	}
}

impl Ord for RankedMatch {
	fn cmp(&self, other: &Self) -> Ordering {
		compare_matches(&self.0, &other.0)
	}
}

struct BoundedMatches {
	limit: usize,
	heap:  BinaryHeap<RankedMatch>,
}

impl BoundedMatches {
	const fn new(limit: usize) -> Self {
		Self { limit, heap: BinaryHeap::new() }
	}

	fn insert(&mut self, entry: GlobMatch) -> bool {
		if self.limit == 0 {
			return false;
		}
		if self.heap.len() < self.limit {
			self.heap.push(RankedMatch(entry));
			return true;
		}
		let Some(worst) = self.heap.peek() else {
			return false;
		};
		if compare_matches(&entry, &worst.0) != Ordering::Less {
			return false;
		}
		self.heap.pop();
		self.heap.push(RankedMatch(entry));
		true
	}

	fn sorted(&self) -> Vec<GlobMatch> {
		let mut entries: Vec<_> = self.heap.iter().map(|entry| entry.0.clone()).collect();
		entries.sort_by(compare_matches);
		entries
	}

	#[cfg(test)]
	fn len(&self) -> usize {
		self.heap.len()
	}
}

fn resolve_symlink_target_type(root: &Path, relative_path: &str) -> Option<FileType> {
	let target_path = root.join(relative_path);
	let metadata = std::fs::metadata(target_path).ok()?;
	if metadata.is_dir() {
		Some(FileType::Dir)
	} else if metadata.is_file() {
		Some(FileType::File)
	} else {
		None
	}
}

fn apply_file_type_filter(entry: &GlobMatch, config: &GlobConfig) -> Option<FileType> {
	let Some(filter) = config.file_type_filter else {
		return Some(entry.file_type);
	};
	if entry.file_type == filter {
		return Some(entry.file_type);
	}
	if entry.file_type != FileType::Symlink {
		return None;
	}
	match filter {
		FileType::File | FileType::Dir => {
			let resolved = resolve_symlink_target_type(&config.root, &entry.path)?;
			if resolved == filter {
				Some(resolved)
			} else {
				None
			}
		},
		FileType::Symlink => None,
	}
}

/// Filter and collect matching entries from a pre-scanned list.
fn filter_entries(
	entries: &[GlobMatch],
	glob_set: &GlobSet,
	config: &GlobConfig,
	on_match: Option<&ThreadsafeFunction<GlobMatch>>,
	ct: &task::CancelToken,
) -> Result<Vec<GlobMatch>> {
	let mut matches = Vec::new();
	if config.max_results == 0 {
		return Ok(matches);
	}

	for entry in entries {
		ct.heartbeat()?;
		if fs_cache::should_skip_path(Path::new(&entry.path), config.mentions_node_modules) {
			// Apply post-scan node_modules policy before glob matching.
			continue;
		}
		if !glob_set.is_match(&entry.path) {
			continue;
		}
		let Some(effective_file_type) = apply_file_type_filter(entry, config) else {
			continue;
		};
		let mut matched_entry = entry.clone();
		matched_entry.file_type = effective_file_type;
		if let Some(callback) = on_match {
			callback.call(Ok(matched_entry.clone()), ThreadsafeFunctionCallMode::NonBlocking);
		}

		matches.push(matched_entry);
		// Only early-break when not sorting; mtime sort requires full candidate set.
		if !config.sort_by_mtime && matches.len() >= config.max_results {
			break;
		}
	}
	Ok(matches)
}

fn emit_snapshot(entries: &[GlobMatch], on_match: Option<&ThreadsafeFunction<GlobMatch>>) {
	let Some(callback) = on_match else {
		return;
	};
	for entry in entries {
		callback.call(Ok(entry.clone()), ThreadsafeFunctionCallMode::NonBlocking);
	}
}

fn collect_uncached_entries(
	glob_set: &GlobSet,
	config: &GlobConfig,
	on_match: Option<&ThreadsafeFunction<GlobMatch>>,
	ct: &task::CancelToken,
) -> Result<Vec<GlobMatch>> {
	let builder = fs_cache::build_walker(
		&config.root,
		config.include_hidden,
		config.use_gitignore,
		!config.mentions_node_modules,
		false,
	);
	let mut unsorted = Vec::new();
	let mut ranked = BoundedMatches::new(config.max_results);
	let mut progress_snapshots = 0;
	let mut progress_dirty = false;
	let now = Instant::now();
	let mut last_progress = now.checked_sub(config.progress_interval).unwrap_or(now);

	for walked in builder.build() {
		ct.heartbeat()?;
		let Ok(walked) = walked else {
			continue;
		};
		let relative = fs_cache::normalize_relative_path(&config.root, walked.path()).into_owned();
		if relative.is_empty()
			|| fs_cache::should_skip_path(Path::new(&relative), config.mentions_node_modules)
			|| !glob_set.is_match(&relative)
		{
			continue;
		}
		let Some((file_type, mtime, size)) = fs_cache::classify_file_type(walked.path()) else {
			continue;
		};
		let mut entry =
			GlobMatch { path: relative, file_type, mtime, size: size.map(|value| value as f64) };
		let Some(effective_file_type) = apply_file_type_filter(&entry, config) else {
			continue;
		};
		entry.file_type = effective_file_type;

		if !config.sort_by_mtime {
			if let Some(callback) = on_match {
				callback.call(Ok(entry.clone()), ThreadsafeFunctionCallMode::NonBlocking);
			}
			unsorted.push(entry);
			if unsorted.len() >= config.max_results {
				break;
			}
			continue;
		}

		progress_dirty |= ranked.insert(entry);
		if progress_dirty
			&& progress_snapshots < MAX_PROGRESS_SNAPSHOTS
			&& last_progress.elapsed() >= config.progress_interval
		{
			emit_snapshot(&ranked.sorted(), on_match);
			progress_snapshots += 1;
			progress_dirty = false;
			last_progress = Instant::now();
		}
	}

	if !config.sort_by_mtime {
		return Ok(unsorted);
	}
	let matches = ranked.sorted();
	emit_snapshot(&matches, on_match);
	Ok(matches)
}

/// Executes matching/filtering over scanned entries and optionally streams each
/// hit.
fn run_glob(
	config: GlobConfig,
	on_match: Option<&ThreadsafeFunction<GlobMatch>>,
	ct: task::CancelToken,
) -> Result<GlobResult> {
	let glob_set = glob_util::compile_glob(&config.pattern, config.recursive)?;
	if config.max_results == 0 {
		return Ok(GlobResult { matches: Vec::new(), total_matches: 0 });
	}

	let skip_node_modules = !config.mentions_node_modules;
	let scan_options = fs_cache::ScanOptions {
		include_hidden: config.include_hidden,
		use_gitignore: config.use_gitignore,
		skip_node_modules,
		follow_links: false,
		detail: if config.sort_by_mtime {
			fs_cache::ScanDetail::Full
		} else {
			fs_cache::ScanDetail::Minimal
		},
	};
	let mut matches = if config.use_cache {
		let scan = fs_cache::get_or_scan(&config.root, scan_options, &ct)?;
		let mut matches = filter_entries(&scan.entries, &glob_set, &config, on_match, &ct)?;
		// Empty-result recheck: if we got zero matches from a cached scan that's old
		// enough, force a rescan and try once more before returning empty.
		if matches.is_empty() && scan.cache_age_ms >= fs_cache::empty_recheck_ms() {
			let fresh = fs_cache::force_rescan(&config.root, scan_options, true, &ct)?;
			matches = filter_entries(&fresh, &glob_set, &config, on_match, &ct)?;
		}
		matches
	} else {
		collect_uncached_entries(&glob_set, &config, on_match, &ct)?
	};

	if config.sort_by_mtime {
		// Cached sorting still ranks the complete snapshot; uncached collection is
		// already bounded.
		matches.sort_by(compare_matches);
		matches.truncate(config.max_results);
	}
	let total_matches = matches.len().min(u32::MAX as usize) as u32;
	Ok(GlobResult { matches, total_matches })
}

/// Find filesystem entries matching a glob pattern.
///
/// Resolves the search root, scans entries, applies glob and optional file-type
/// filters, and optionally streams each accepted match through `on_match`.
///
/// If `sortByMtime` is enabled, all matching entries are collected, sorted by
/// descending mtime, then truncated to `maxResults`.
///
/// # Errors
/// Returns an error when the search path cannot be resolved, the path is not a
/// directory, the glob pattern is invalid, or cancellation/timeout is
/// triggered.
#[napi]
pub fn glob(
	options: GlobOptions<'_>,
	#[napi(ts_arg_type = "((error: Error | null, match: GlobMatch) => void) | undefined | null")]
	on_match: Option<ThreadsafeFunction<GlobMatch>>,
) -> task::Promise<GlobResult> {
	let GlobOptions {
		pattern,
		path,
		file_type,
		recursive,
		hidden,
		max_results,
		gitignore,
		sort_by_mtime,
		cache,
		include_node_modules,
		timeout_ms,
		signal,
	} = options;

	let pattern = pattern.trim();
	let pattern = if pattern.is_empty() { "*" } else { pattern };
	let pattern = pattern.to_string();

	let progress_interval_ms = timeout_ms.map_or(DEFAULT_PROGRESS_INTERVAL_MS, |value| {
		u64::from(value).div_ceil(MAX_PROGRESS_SNAPSHOTS as u64)
	});
	let progress_interval = Duration::from_millis(progress_interval_ms.max(1));
	let ct = task::CancelToken::new(timeout_ms, signal);

	task::blocking("glob", ct, move |ct| {
		run_glob(
			GlobConfig {
				root: fs_cache::resolve_search_path(&path)?,
				include_hidden: hidden.unwrap_or(false),
				file_type_filter: file_type,
				recursive: recursive.unwrap_or(true),
				max_results: max_results.map_or(usize::MAX, |value| value as usize),
				use_gitignore: gitignore.unwrap_or(true),
				mentions_node_modules: include_node_modules
					.unwrap_or_else(|| pattern.contains("node_modules")),
				sort_by_mtime: sort_by_mtime.unwrap_or(false),
				use_cache: cache.unwrap_or(false),
				progress_interval,
				pattern,
			},
			on_match.as_ref(),
			ct,
		)
	})
}

#[cfg(test)]
mod tests {
	use super::*;

	fn candidate(path: String, mtime: f64) -> GlobMatch {
		GlobMatch { path, file_type: FileType::File, mtime: Some(mtime), size: Some(0.0) }
	}

	#[test]
	fn bounded_matches_keeps_newest_entries_beyond_the_old_scan_limit() {
		let mut matches = BoundedMatches::new(3);
		for index in 0..250_003 {
			matches.insert(candidate(format!("entry-{index:06}.txt"), index as f64));
		}

		assert_eq!(matches.len(), 3);
		assert_eq!(
			matches
				.sorted()
				.into_iter()
				.map(|entry| entry.path)
				.collect::<Vec<_>>(),
			["entry-250002.txt", "entry-250001.txt", "entry-250000.txt"],
		);
	}

	#[test]
	fn bounded_matches_breaks_mtime_ties_by_path() {
		let mut matches = BoundedMatches::new(2);
		for path in ["z.txt", "a.txt", "m.txt"] {
			matches.insert(candidate(path.to_string(), 42.0));
		}

		assert_eq!(
			matches
				.sorted()
				.into_iter()
				.map(|entry| entry.path)
				.collect::<Vec<_>>(),
			["a.txt", "m.txt"],
		);
	}
}
