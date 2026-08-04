//! Bounded shared filesystem scans for native discovery tools.
//!
//! Provides complete-or-error directory snapshots with:
//! - Strict per-scan entry and successful-snapshot retained-capacity budgets
//! - Immutable `Arc` snapshots and aggregate cache budgets
//! - Generation-safe publication and explicit mutation invalidation
//! - Global TTL and empty-result recheck policy
//!
//! `FS_SCAN_MAX_BYTES` is a logical ownership budget, not a hard allocator or
//! RSS-peak limit. Allocation requests are precharged, then the actual `Vec`
//! and `String` capacities returned by the allocator are reconciled. A scan is
//! discarded if those retained capacities exceed the budget, but an allocator
//! may transiently grant more memory before that check can run.
//!
//! # Policy configuration (environment overrides)
//! - `FS_SCAN_MAX_ENTRIES`         – default `250000`
//! - `FS_SCAN_MAX_BYTES`           – default `67108864` (64 MiB)
//! - `FS_SCAN_CACHE_TTL_MS`        – default `1000`; `0` bypasses caching
//! - `FS_SCAN_EMPTY_RECHECK_MS`    – default `200`
//! - `FS_SCAN_CACHE_MAX_ENTRIES`   – default `16`
//! - `FS_SCAN_CACHE_MAX_BYTES`     – default `134217728` (128 MiB); `0`
//!   disables caching

use std::{
	borrow::Cow,
	collections::HashMap,
	mem::size_of,
	path::{Path, PathBuf},
	sync::{Arc, LazyLock},
	time::{Duration, Instant},
};

use ignore::{ParallelVisitor, ParallelVisitorBuilder, WalkBuilder, WalkState};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use parking_lot::Mutex;

use crate::{env_uint, task};

// ═══════════════════════════════════════════════════════════════════════════
// Public types (re-exported by glob for backward compatibility)
// ═══════════════════════════════════════════════════════════════════════════

/// Resolved filesystem entry kind for glob filters and match metadata.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[napi]
pub enum FileType {
	/// Regular file.
	File    = 1,
	/// Directory.
	Dir     = 2,
	/// Symbolic link.
	Symlink = 3,
}

/// A single filesystem entry from a directory scan.
#[derive(Clone)]
#[napi(object)]
pub struct GlobMatch {
	/// Relative path from the search root, using forward slashes.
	pub path:      String,
	/// Resolved filesystem type for the match.
	pub file_type: FileType,
	/// Modification time in milliseconds since Unix epoch (from
	/// `symlink_metadata`).
	pub mtime:     Option<f64>,
	/// File size in bytes for regular files.
	pub size:      Option<f64>,
}

const SCAN_MAX_ENTRIES_DEFAULT: usize = 250_000;
const SCAN_MAX_ENTRIES_MIN: usize = 1;
const SCAN_MAX_ENTRIES_MAX: usize = 1_000_000;
const SCAN_MAX_BYTES_DEFAULT: usize = 64 * 1024 * 1024;
const SCAN_MAX_BYTES_MIN: usize = 1024 * 1024;
const SCAN_MAX_BYTES_MAX: usize = 512 * 1024 * 1024;
const CACHE_MAX_ENTRIES_DEFAULT: usize = 16;
const CACHE_MAX_ENTRIES_MIN: usize = 1;
const CACHE_MAX_ENTRIES_MAX: usize = 64;
const CACHE_MAX_BYTES_DEFAULT: usize = 128 * 1024 * 1024;
const CACHE_MAX_BYTES_MIN: usize = 1024 * 1024;
const CACHE_MAX_BYTES_MAX: usize = 2 * 1024 * 1024 * 1024;

#[derive(Clone, Copy)]
struct ScanPolicy {
	max_entries:   usize,
	max_bytes:     usize,
	cache_entries: usize,
	cache_bytes:   usize,
}

fn bounded_value(value: &str) -> String {
	value.chars().take(128).collect()
}

fn parse_limit_value(
	name: &'static str,
	value: Option<&str>,
	default: usize,
	min: usize,
	max: usize,
	allow_zero: bool,
) -> std::result::Result<usize, String> {
	let Some(value) = value else {
		return Ok(default);
	};
	if value.starts_with(['+', '-']) {
		return Err(format!(
			"FS_SCAN_CONFIG_INVALID name={name} reason=signed value={} min={min} max={max}",
			bounded_value(value)
		));
	}
	let parsed = value.parse::<u128>().map_err(|error| {
		let reason = match error.kind() {
			std::num::IntErrorKind::PosOverflow | std::num::IntErrorKind::NegOverflow => "overflow",
			_ => "malformed",
		};
		format!(
			"FS_SCAN_CONFIG_INVALID name={name} reason={reason} value={} min={min} max={max}",
			bounded_value(value)
		)
	})?;
	if parsed > usize::MAX as u128 {
		return Err(format!(
			"FS_SCAN_CONFIG_INVALID name={name} reason=overflow value={} min={min} max={max}",
			bounded_value(value)
		));
	}
	let parsed = parsed as usize;
	if parsed == 0 {
		if allow_zero {
			return Ok(0);
		}
		return Err(format!(
			"FS_SCAN_CONFIG_INVALID name={name} reason=zero value={} min={min} max={max}",
			bounded_value(value)
		));
	}
	if parsed < min {
		return Err(format!(
			"FS_SCAN_CONFIG_INVALID name={name} reason=below_min value={} min={min} max={max}",
			bounded_value(value)
		));
	}
	if parsed > max {
		return Err(format!(
			"FS_SCAN_CONFIG_INVALID name={name} reason=above_max value={} min={min} max={max}",
			bounded_value(value)
		));
	}
	Ok(parsed)
}

fn parse_limit(
	name: &'static str,
	default: usize,
	min: usize,
	max: usize,
	allow_zero: bool,
) -> std::result::Result<usize, String> {
	match std::env::var(name) {
		Ok(value) => parse_limit_value(name, Some(&value), default, min, max, allow_zero),
		Err(std::env::VarError::NotPresent) => Ok(default),
		Err(std::env::VarError::NotUnicode(_)) => Err(format!(
			"FS_SCAN_CONFIG_INVALID name={name} reason=malformed value=<non-unicode> min={min} \
			 max={max}"
		)),
	}
}

fn scan_policy() -> Result<ScanPolicy> {
	static POLICY: LazyLock<std::result::Result<ScanPolicy, String>> = LazyLock::new(|| {
		Ok(ScanPolicy {
			max_entries:   parse_limit(
				"FS_SCAN_MAX_ENTRIES",
				SCAN_MAX_ENTRIES_DEFAULT,
				SCAN_MAX_ENTRIES_MIN,
				SCAN_MAX_ENTRIES_MAX,
				false,
			)?,
			max_bytes:     parse_limit(
				"FS_SCAN_MAX_BYTES",
				SCAN_MAX_BYTES_DEFAULT,
				SCAN_MAX_BYTES_MIN,
				SCAN_MAX_BYTES_MAX,
				false,
			)?,
			cache_entries: parse_limit(
				"FS_SCAN_CACHE_MAX_ENTRIES",
				CACHE_MAX_ENTRIES_DEFAULT,
				CACHE_MAX_ENTRIES_MIN,
				CACHE_MAX_ENTRIES_MAX,
				false,
			)?,
			cache_bytes:   parse_limit(
				"FS_SCAN_CACHE_MAX_BYTES",
				CACHE_MAX_BYTES_DEFAULT,
				CACHE_MAX_BYTES_MIN,
				CACHE_MAX_BYTES_MAX,
				true,
			)?,
		})
	});
	POLICY
		.as_ref()
		.copied()
		.map_err(|err| Error::from_reason(err.clone()))
}

env_uint! {
	static CACHE_TTL_MS: u64 = "FS_SCAN_CACHE_TTL_MS" or 1_000 => [0, u64::MAX];
	static EMPTY_RECHECK_MS: u64 = "FS_SCAN_EMPTY_RECHECK_MS" or 200 => [0, u64::MAX];
}
env_uint! {
	static GREP_WORKERS: usize = "PI_GREP_WORKERS" or 4 => [0, usize::MAX];
}

pub fn cache_ttl_ms() -> u64 {
	*CACHE_TTL_MS
}
pub fn empty_recheck_ms() -> u64 {
	*EMPTY_RECHECK_MS
}
pub fn grep_workers() -> usize {
	*GREP_WORKERS
}

// ═══════════════════════════════════════════════════════════════════════════
// Cache internals
// ═══════════════════════════════════════════════════════════════════════════

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct CacheKey {
	root:              PathBuf,
	include_hidden:    bool,
	use_gitignore:     bool,
	skip_node_modules: bool,
	follow_links:      bool,
	detail:            ScanDetail,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum ScanDetail {
	Minimal,
	Full,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct ScanOptions {
	pub include_hidden:    bool,
	pub use_gitignore:     bool,
	pub skip_node_modules: bool,
	pub follow_links:      bool,
	pub detail:            ScanDetail,
}

struct CacheEntry {
	created_at: Instant,
	entries:    Arc<Vec<GlobMatch>>,
	bytes:      usize,
}

#[derive(Default)]
struct CacheState {
	entries:              HashMap<CacheKey, CacheEntry>,
	bytes:                usize,
	generation:           u64,
	publication_disabled: bool,
}

static FS_CACHE: LazyLock<Mutex<CacheState>> = LazyLock::new(|| Mutex::new(CacheState::default()));

pub struct ScanResult {
	/// Shared immutable filesystem snapshot.
	pub entries:      Arc<Vec<GlobMatch>>,
	pub cache_age_ms: u64,
}

fn snapshot_bytes(entries: &Arc<Vec<GlobMatch>>) -> Option<usize> {
	let vectors = entries.capacity().checked_mul(size_of::<GlobMatch>())?;
	entries
		.iter()
		.try_fold(vectors, |total, entry| total.checked_add(entry.path.capacity()))
}

fn cache_key(root: &Path, options: ScanOptions) -> CacheKey {
	CacheKey {
		root:              root.to_path_buf(),
		include_hidden:    options.include_hidden,
		use_gitignore:     options.use_gitignore,
		skip_node_modules: options.skip_node_modules,
		follow_links:      options.follow_links,
		detail:            options.detail,
	}
}

fn advance_generation(state: &mut CacheState) {
	let Some(next) = state.generation.checked_add(1) else {
		state.entries.clear();
		state.bytes = 0;
		state.publication_disabled = true;
		return;
	};
	state.generation = next;
}

fn remove_entry(state: &mut CacheState, key: &CacheKey) {
	if let Some(entry) = state.entries.remove(key) {
		let Some(bytes) = state.bytes.checked_sub(entry.bytes) else {
			state.entries.clear();
			state.bytes = 0;
			state.publication_disabled = true;
			return;
		};
		state.bytes = bytes;
	}
}

fn publish(
	state: &mut CacheState,
	key: CacheKey,
	created_at: Instant,
	entries: Arc<Vec<GlobMatch>>,
	policy: ScanPolicy,
) -> bool {
	if state.publication_disabled || policy.cache_bytes == 0 {
		return false;
	}
	let Some(bytes) = snapshot_bytes(&entries) else {
		return false;
	};
	if bytes > policy.cache_bytes {
		return false;
	}
	remove_entry(state, &key);
	while state.entries.len() >= policy.cache_entries
		|| state
			.bytes
			.checked_add(bytes)
			.is_none_or(|total| total > policy.cache_bytes)
	{
		let Some(oldest) = state
			.entries
			.iter()
			.min_by_key(|(_, entry)| entry.created_at)
			.map(|(key, _)| key.clone())
		else {
			break;
		};
		remove_entry(state, &oldest);
	}
	if state.entries.len() >= policy.cache_entries
		|| state
			.bytes
			.checked_add(bytes)
			.is_none_or(|total| total > policy.cache_bytes)
	{
		return false;
	}
	state.bytes += bytes;
	state
		.entries
		.insert(key, CacheEntry { created_at, entries, bytes });
	true
}

fn publish_if_current(
	state: &mut CacheState,
	generation: u64,
	key: CacheKey,
	created_at: Instant,
	entries: Arc<Vec<GlobMatch>>,
	policy: ScanPolicy,
) -> bool {
	state.generation == generation && publish(state, key, created_at, entries, policy)
}

fn publish_or_adopt(
	state: &mut CacheState,
	generation: u64,
	key: CacheKey,
	completed_at: Instant,
	ttl: Duration,
	entries: Arc<Vec<GlobMatch>>,
	policy: ScanPolicy,
) -> Arc<Vec<GlobMatch>> {
	if state.generation != generation {
		return entries;
	}
	let expired = state
		.entries
		.get(&key)
		.is_some_and(|existing| completed_at.saturating_duration_since(existing.created_at) >= ttl);
	if expired {
		remove_entry(state, &key);
	}
	if let Some(existing) = state.entries.get(&key) {
		return Arc::clone(&existing.entries);
	}
	publish(state, key.clone(), completed_at, Arc::clone(&entries), policy);
	state
		.entries
		.get(&key)
		.map_or(entries, |published| Arc::clone(&published.entries))
}

// ═══════════════════════════════════════════════════════════════════════════
// Path utilities
// ═══════════════════════════════════════════════════════════════════════════

/// Resolve a search path string to a canonical `PathBuf` (must be a directory).
pub fn resolve_search_path(path: &str) -> Result<PathBuf> {
	let candidate = PathBuf::from(path);
	let root = if candidate.is_absolute() {
		candidate
	} else {
		let cwd = std::env::current_dir()
			.map_err(|err| Error::from_reason(format!("Failed to resolve cwd: {err}")))?;
		cwd.join(candidate)
	};
	let metadata = std::fs::metadata(&root)
		.map_err(|err| Error::from_reason(format!("Path not found: {err}")))?;
	if !metadata.is_dir() {
		return Err(Error::from_reason("Search path must be a directory".to_string()));
	}
	Ok(std::fs::canonicalize(&root).unwrap_or(root))
}

/// Normalize a filesystem path to a forward-slash relative string.
pub fn normalize_relative_path<'a>(root: &Path, path: &'a Path) -> Cow<'a, str> {
	let relative = path.strip_prefix(root).unwrap_or(path);
	if cfg!(windows) {
		let relative = relative.to_string_lossy();
		if relative.contains('\\') {
			Cow::Owned(relative.replace('\\', "/"))
		} else {
			relative
		}
	} else {
		relative.to_string_lossy()
	}
}

pub fn contains_component(path: &Path, target: &str) -> bool {
	path.components().any(|component| {
		component
			.as_os_str()
			.to_str()
			.is_some_and(|value| value == target)
	})
}

pub fn should_skip_path(path: &Path, mentions_node_modules: bool) -> bool {
	// Always skip VCS internals; they are noise for user-facing discovery.
	if contains_component(path, ".git") {
		return true;
	}
	if !mentions_node_modules && contains_component(path, "node_modules") {
		// Skip node_modules by default unless explicitly requested/pattern-matched.
		return true;
	}
	false
}

fn file_type_from_std(file_type: std::fs::FileType) -> Option<FileType> {
	if file_type.is_symlink() {
		Some(FileType::Symlink)
	} else if file_type.is_dir() {
		Some(FileType::Dir)
	} else if file_type.is_file() {
		Some(FileType::File)
	} else {
		None
	}
}

fn mtime_ms(metadata: &std::fs::Metadata) -> Option<f64> {
	metadata
		.modified()
		.ok()
		.and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
		.map(|d| d.as_millis() as f64)
}

pub fn classify_file_type(path: &Path) -> Option<(FileType, Option<f64>, Option<u64>)> {
	let metadata = std::fs::symlink_metadata(path).ok()?;
	let file_type = file_type_from_std(metadata.file_type())?;
	let size = if file_type == FileType::File {
		Some(metadata.len())
	} else {
		None
	};
	Some((file_type, mtime_ms(&metadata), size))
}

// ═══════════════════════════════════════════════════════════════════════════
// Walker + collection
// ═══════════════════════════════════════════════════════════════════════════

/// Builds a deterministic filesystem walker configured for visibility and
/// ignore rules.
///
/// When `skip_node_modules` is true, `node_modules` directories are pruned at
/// traversal time (not just filtered post-scan). `.git` is always skipped.
#[allow(clippy::fn_params_excessive_bools, reason = "matches WalkBuilder option fields")]
pub fn build_walker(
	root: &Path,
	include_hidden: bool,
	use_gitignore: bool,
	skip_node_modules: bool,
	follow_links: bool,
) -> WalkBuilder {
	let mut builder = WalkBuilder::new(root);
	builder
		.hidden(!include_hidden)
		.follow_links(follow_links)
		.sort_by_file_path(|a, b| a.cmp(b))
		// filter_entry controls whether to yield an entry AND whether to descend
		// into a directory. Returning false for a directory skips the entire subtree.
		.filter_entry(move |entry| {
			let name = entry.file_name().to_str().unwrap_or_default();
			// Always skip .git
			if name == ".git" {
				return false;
			}
			// Skip node_modules when skip_node_modules is true
			if skip_node_modules && name == "node_modules" {
				return false;
			}
			true
		});

	if use_gitignore {
		// Honor repository and global ignore files for repo-like behavior.
		builder
			.git_ignore(true)
			.git_exclude(true)
			.git_global(true)
			.ignore(true)
			.parents(true);
	} else {
		// Disable all ignore sources for exhaustive filesystem traversal.
		builder
			.git_ignore(false)
			.git_exclude(false)
			.git_global(false)
			.ignore(false)
			.parents(false);
	}

	builder
}

#[derive(Clone, Copy)]
struct CandidateReservation {
	path_bytes: usize,
}

struct CollectorState {
	entries:                Vec<GlobMatch>,
	charged_bytes:          usize,
	reserved_entries:       usize,
	claimed_slots:          usize,
	charged_capacity_slots: usize,
	terminal:               Option<String>,
}

fn bounded_root(root: &Path) -> String {
	root.to_string_lossy().chars().take(128).collect()
}

fn scan_limit_error(
	root: &Path,
	operation: &str,
	dimension: &str,
	maximum: usize,
	attempted: &str,
) -> String {
	format!(
		"FS_SCAN_LIMIT operation={operation} dimension={dimension} root={} maximum={maximum} \
		 attempted={attempted} remediation=narrow-search",
		bounded_root(root)
	)
}

#[cfg(unix)]
fn normalized_path_capacity(relative: &Path) -> Option<usize> {
	use std::os::unix::ffi::OsStrExt;
	relative.as_os_str().as_bytes().len().checked_mul(3)
}

#[cfg(windows)]
fn normalized_path_capacity(relative: &Path) -> Option<usize> {
	use std::os::windows::ffi::OsStrExt;
	relative.as_os_str().encode_wide().count().checked_mul(3)
}

#[cfg(not(any(unix, windows)))]
fn normalized_path_capacity(relative: &Path) -> Option<usize> {
	relative.as_os_str().as_encoded_bytes().len().checked_mul(3)
}

#[cfg(unix)]
fn normalized_path_len(relative: &Path) -> Option<usize> {
	use std::os::unix::ffi::OsStrExt;
	let mut length = 0usize;
	let mut remaining = relative.as_os_str().as_bytes();
	while !remaining.is_empty() {
		match std::str::from_utf8(remaining) {
			Ok(valid) => return length.checked_add(valid.len()),
			Err(error) => {
				length = length
					.checked_add(error.valid_up_to())?
					.checked_add(char::REPLACEMENT_CHARACTER.len_utf8())?;
				let invalid = error
					.error_len()
					.unwrap_or_else(|| remaining.len() - error.valid_up_to());
				remaining = &remaining[error.valid_up_to() + invalid..];
			},
		}
	}
	Some(length)
}

#[cfg(windows)]
fn normalized_path_len(relative: &Path) -> Option<usize> {
	use std::os::windows::ffi::OsStrExt;
	char::decode_utf16(relative.as_os_str().encode_wide()).try_fold(0usize, |length, decoded| {
		let character = decoded.unwrap_or(char::REPLACEMENT_CHARACTER);
		length.checked_add(character.len_utf8())
	})
}

#[cfg(not(any(unix, windows)))]
fn normalized_path_len(relative: &Path) -> Option<usize> {
	relative
		.to_string_lossy()
		.chars()
		.try_fold(0usize, |length, character| length.checked_add(character.len_utf8()))
}

fn normalized_relative_path_fallible(
	relative: &Path,
	charged_capacity: usize,
) -> std::result::Result<String, ()> {
	#[cfg(unix)]
	{
		use std::os::unix::ffi::OsStrExt;
		if let Ok(valid) = std::str::from_utf8(relative.as_os_str().as_bytes()) {
			if valid.len() > charged_capacity {
				return Err(());
			}
			let mut normalized = String::new();
			normalized.try_reserve_exact(valid.len()).map_err(|_| ())?;
			normalized.push_str(valid);
			return Ok(normalized);
		}
	}
	let required_capacity = normalized_path_len(relative).ok_or(())?;
	if required_capacity > charged_capacity {
		return Err(());
	}
	let mut normalized = String::new();
	normalized
		.try_reserve_exact(required_capacity)
		.map_err(|_| ())?;

	#[cfg(unix)]
	{
		use std::os::unix::ffi::OsStrExt;
		let mut remaining = relative.as_os_str().as_bytes();
		while !remaining.is_empty() {
			match std::str::from_utf8(remaining) {
				Ok(valid) => {
					normalized.push_str(valid);
					break;
				},
				Err(error) => {
					let valid_up_to = error.valid_up_to();
					if valid_up_to > 0 {
						// SAFETY: `valid_up_to` is the UTF-8-valid prefix reported by
						// `Utf8Error`.
						normalized
							.push_str(unsafe { std::str::from_utf8_unchecked(&remaining[..valid_up_to]) });
					}
					normalized.push('\u{fffd}');
					let invalid = error
						.error_len()
						.unwrap_or_else(|| remaining.len() - valid_up_to);
					remaining = &remaining[valid_up_to + invalid..];
				},
			}
		}
	}

	#[cfg(windows)]
	{
		use std::os::windows::ffi::OsStrExt;
		for decoded in char::decode_utf16(relative.as_os_str().encode_wide()) {
			let mut character = decoded.unwrap_or(char::REPLACEMENT_CHARACTER);
			if character == '\\' {
				character = '/';
			}
			normalized.push(character);
		}
	}

	#[cfg(not(any(unix, windows)))]
	{
		for character in relative.to_string_lossy().chars() {
			normalized.push(if character == '\\' { '/' } else { character });
		}
	}

	Ok(normalized)
}

impl CollectorState {
	fn fail(&mut self, message: String) {
		if self.terminal.is_none() {
			self.terminal = Some(message);
		}
	}

	fn rollback_reservation(
		&mut self,
		root: &Path,
		policy: ScanPolicy,
		reservation: CandidateReservation,
	) {
		let Some(reserved_entries) = self.reserved_entries.checked_sub(1) else {
			self.fail(scan_limit_error(
				root,
				"rollback",
				"transaction",
				policy.max_entries,
				"entry-underflow",
			));
			return;
		};
		let Some(charged_bytes) = self.charged_bytes.checked_sub(reservation.path_bytes) else {
			self.fail(scan_limit_error(
				root,
				"rollback",
				"transaction",
				policy.max_bytes,
				"byte-underflow",
			));
			return;
		};
		self.reserved_entries = reserved_entries;
		self.charged_bytes = charged_bytes;
	}

	fn begin_candidate(
		&mut self,
		root: &Path,
		relative: &Path,
		policy: ScanPolicy,
	) -> std::result::Result<CandidateReservation, ()> {
		if self.terminal.is_some() {
			return Err(());
		}
		let Some(path_bytes) = normalized_path_capacity(relative) else {
			self.fail(scan_limit_error(root, "collect", "bytes", policy.max_bytes, "overflow"));
			return Err(());
		};
		let Some(next_entries) = self.reserved_entries.checked_add(1) else {
			self.fail(scan_limit_error(root, "collect", "entries", policy.max_entries, "overflow"));
			return Err(());
		};
		let Some(next_bytes) = self.charged_bytes.checked_add(path_bytes) else {
			self.fail(scan_limit_error(root, "collect", "bytes", policy.max_bytes, "overflow"));
			return Err(());
		};
		if next_entries > policy.max_entries {
			self.fail(scan_limit_error(
				root,
				"collect",
				"entries",
				policy.max_entries,
				&next_entries.to_string(),
			));
			return Err(());
		}
		if next_bytes > policy.max_bytes {
			self.fail(scan_limit_error(
				root,
				"collect",
				"bytes",
				policy.max_bytes,
				&next_bytes.to_string(),
			));
			return Err(());
		}

		self.reserved_entries = next_entries;
		self.charged_bytes = next_bytes;
		let reservation = CandidateReservation { path_bytes };
		if self.claim_slot(root, policy).is_err() {
			self.rollback_reservation(root, policy, reservation);
			return Err(());
		}
		Ok(reservation)
	}

	fn claim_slot(&mut self, root: &Path, policy: ScanPolicy) -> std::result::Result<(), ()> {
		let Some(occupied_slots) = self.entries.len().checked_add(self.claimed_slots) else {
			self.fail(scan_limit_error(root, "reserve", "entries", policy.max_entries, "overflow"));
			return Err(());
		};
		if occupied_slots < self.charged_capacity_slots {
			self.claimed_slots += 1;
			return Ok(());
		}
		if self.charged_capacity_slots != self.entries.capacity() {
			self.fail(scan_limit_error(
				root,
				"reserve",
				"transaction",
				policy.max_entries,
				"capacity-mismatch",
			));
			return Err(());
		}

		let Some(minimum_target) = occupied_slots.checked_add(1) else {
			self.fail(scan_limit_error(root, "reserve", "entries", policy.max_entries, "overflow"));
			return Err(());
		};
		let growth_target = if self.charged_capacity_slots == 0 {
			64.min(policy.max_entries)
		} else {
			self
				.charged_capacity_slots
				.checked_mul(2)
				.unwrap_or(policy.max_entries)
				.min(policy.max_entries)
		};
		if minimum_target > policy.max_entries {
			self.fail(scan_limit_error(
				root,
				"reserve",
				"entries",
				policy.max_entries,
				&minimum_target.to_string(),
			));
			return Err(());
		}
		let desired_target = growth_target.max(minimum_target);
		let Some(available_bytes) = policy.max_bytes.checked_sub(self.charged_bytes) else {
			self.fail(scan_limit_error(
				root,
				"reserve",
				"bytes",
				policy.max_bytes,
				&self.charged_bytes.to_string(),
			));
			return Err(());
		};
		let affordable_additional_slots = available_bytes / size_of::<GlobMatch>();
		let affordable_target = self
			.charged_capacity_slots
			.saturating_add(affordable_additional_slots)
			.min(policy.max_entries);
		let requested_target = desired_target.min(affordable_target);
		if requested_target < minimum_target {
			let attempted_bytes = minimum_target
				.checked_sub(self.charged_capacity_slots)
				.and_then(|slots| slots.checked_mul(size_of::<GlobMatch>()))
				.and_then(|bytes| self.charged_bytes.checked_add(bytes))
				.map_or_else(|| "overflow".to_string(), |bytes| bytes.to_string());
			self.fail(scan_limit_error(root, "reserve", "bytes", policy.max_bytes, &attempted_bytes));
			return Err(());
		}

		let additional_slots = requested_target - self.charged_capacity_slots;
		let Some(additional_bytes) = additional_slots.checked_mul(size_of::<GlobMatch>()) else {
			self.fail(scan_limit_error(root, "reserve", "bytes", policy.max_bytes, "overflow"));
			return Err(());
		};
		let Some(precharged_bytes) = self.charged_bytes.checked_add(additional_bytes) else {
			self.fail(scan_limit_error(root, "reserve", "bytes", policy.max_bytes, "overflow"));
			return Err(());
		};

		self.charged_bytes = precharged_bytes;
		let additional = requested_target - self.entries.len();
		// `try_reserve_exact` avoids deliberate speculative growth, but the
		// allocator may still grant more capacity than requested. The precharge
		// bounds the logical request; the reconciliation below decides whether the
		// returned capacity is admissible for a successful snapshot.
		if self.entries.try_reserve_exact(additional).is_err() {
			let Some(rolled_back_bytes) = self.charged_bytes.checked_sub(additional_bytes) else {
				self.fail(scan_limit_error(
					root,
					"reserve",
					"transaction",
					policy.max_bytes,
					"precharge-underflow",
				));
				return Err(());
			};
			self.charged_bytes = rolled_back_bytes;
			self.fail(scan_limit_error(
				root,
				"reserve",
				"allocation",
				policy.max_bytes,
				&additional.to_string(),
			));
			return Err(());
		}

		let actual_capacity = self.entries.capacity();
		let Some(actual_additional_slots) = actual_capacity.checked_sub(self.charged_capacity_slots)
		else {
			self.fail(scan_limit_error(
				root,
				"reserve",
				"transaction",
				policy.max_entries,
				"capacity-regressed",
			));
			return Err(());
		};
		let Some(excess_slots) = actual_additional_slots.checked_sub(additional_slots) else {
			self.fail(scan_limit_error(
				root,
				"reserve",
				"transaction",
				policy.max_entries,
				"capacity-underreserved",
			));
			return Err(());
		};
		let Some(excess_bytes) = excess_slots.checked_mul(size_of::<GlobMatch>()) else {
			self.fail(scan_limit_error(root, "reserve", "bytes", policy.max_bytes, "overflow"));
			return Err(());
		};
		let Some(reconciled_bytes) = self.charged_bytes.checked_add(excess_bytes) else {
			self.fail(scan_limit_error(root, "reserve", "bytes", policy.max_bytes, "overflow"));
			return Err(());
		};
		self.charged_capacity_slots = actual_capacity;
		self.charged_bytes = reconciled_bytes;
		if reconciled_bytes > policy.max_bytes {
			self.fail(scan_limit_error(
				root,
				"reserve",
				"bytes",
				policy.max_bytes,
				&reconciled_bytes.to_string(),
			));
			return Err(());
		}

		self.claimed_slots += 1;
		Ok(())
	}
}

struct EntryVisitor<'a> {
	root:      &'a Path,
	detail:    ScanDetail,
	ct:        &'a task::CancelToken,
	policy:    ScanPolicy,
	collector: Arc<Mutex<CollectorState>>,
	visited:   usize,
}

impl ParallelVisitor for EntryVisitor<'_> {
	fn visit(&mut self, entry: std::result::Result<ignore::DirEntry, ignore::Error>) -> WalkState {
		if self.visited == 0 || self.visited >= 128 {
			self.visited = 0;
			if let Err(err) = self.ct.heartbeat() {
				let mut state = self.collector.lock();
				state.fail(err.to_string());
				return WalkState::Quit;
			}
		}
		self.visited += 1;
		let Ok(entry) = entry else {
			return WalkState::Continue;
		};
		let relative = entry
			.path()
			.strip_prefix(self.root)
			.unwrap_or_else(|_| entry.path());
		if relative.as_os_str().is_empty() {
			return WalkState::Continue;
		}

		let Some(metadata) = collect_entry_metadata(&entry, self.detail) else {
			return WalkState::Continue;
		};
		let mut state = self.collector.lock();
		let Ok(reservation) = state.begin_candidate(self.root, relative, self.policy) else {
			return WalkState::Quit;
		};
		let candidate = collect_entry(relative, reservation.path_bytes, metadata);
		let Some(claimed_slots) = state.claimed_slots.checked_sub(1) else {
			state.fail(scan_limit_error(
				self.root,
				"collect",
				"transaction",
				self.policy.max_entries,
				"claim-underflow",
			));
			state.rollback_reservation(self.root, self.policy, reservation);
			return WalkState::Quit;
		};
		state.claimed_slots = claimed_slots;

		let Ok(candidate) = candidate else {
			state.fail(scan_limit_error(
				self.root,
				"collect",
				"allocation",
				self.policy.max_bytes,
				"path",
			));
			state.rollback_reservation(self.root, self.policy, reservation);
			return WalkState::Quit;
		};
		if state.terminal.is_some() {
			state.rollback_reservation(self.root, self.policy, reservation);
			return WalkState::Quit;
		}

		let Some(without_reserved_path) = state.charged_bytes.checked_sub(reservation.path_bytes)
		else {
			state.fail(scan_limit_error(
				self.root,
				"collect",
				"transaction",
				self.policy.max_bytes,
				"path-underflow",
			));
			state.rollback_reservation(self.root, self.policy, reservation);
			return WalkState::Quit;
		};
		let Some(reconciled_bytes) = without_reserved_path.checked_add(candidate.path.capacity())
		else {
			state.fail(scan_limit_error(
				self.root,
				"collect",
				"bytes",
				self.policy.max_bytes,
				"overflow",
			));
			state.rollback_reservation(self.root, self.policy, reservation);
			return WalkState::Quit;
		};
		if reconciled_bytes > self.policy.max_bytes {
			state.fail(scan_limit_error(
				self.root,
				"collect",
				"bytes",
				self.policy.max_bytes,
				&reconciled_bytes.to_string(),
			));
			state.rollback_reservation(self.root, self.policy, reservation);
			return WalkState::Quit;
		}
		state.charged_bytes = reconciled_bytes;
		debug_assert!(state.entries.len() < state.entries.capacity());
		state.entries.push(candidate);
		WalkState::Continue
	}
}

struct EntryVisitorBuilder<'a> {
	root:      &'a Path,
	detail:    ScanDetail,
	ct:        &'a task::CancelToken,
	policy:    ScanPolicy,
	collector: Arc<Mutex<CollectorState>>,
}

impl<'a> ParallelVisitorBuilder<'a> for EntryVisitorBuilder<'a> {
	fn build(&mut self) -> Box<dyn ParallelVisitor + 'a> {
		Box::new(EntryVisitor {
			root:      self.root,
			detail:    self.detail,
			ct:        self.ct,
			policy:    self.policy,
			collector: Arc::clone(&self.collector),
			visited:   0,
		})
	}
}

fn collect_entries_with_policy(
	root: &Path,
	options: ScanOptions,
	ct: &task::CancelToken,
	policy: ScanPolicy,
) -> Result<Arc<Vec<GlobMatch>>> {
	let mut builder = build_walker(
		root,
		options.include_hidden,
		options.use_gitignore,
		options.skip_node_modules,
		options.follow_links,
	);
	let workers = grep_workers();
	if workers > 0 {
		builder.threads(workers);
	}
	let collector = Arc::new(Mutex::new(CollectorState {
		entries:                Vec::new(),
		charged_bytes:          0,
		reserved_entries:       0,
		claimed_slots:          0,
		charged_capacity_slots: 0,
		terminal:               None,
	}));
	let mut visitor_builder = EntryVisitorBuilder {
		root,
		detail: options.detail,
		ct,
		policy,
		collector: Arc::clone(&collector),
	};
	ct.heartbeat()
		.map_err(|err| Error::from_reason(err.to_string()))?;
	builder.build_parallel().visit(&mut visitor_builder);
	let mut state = collector.lock();
	if let Some(error) = state.terminal.take() {
		return Err(Error::from_reason(error));
	}
	if state.claimed_slots != 0
		|| state.entries.len() != state.reserved_entries
		|| state.charged_capacity_slots != state.entries.capacity()
	{
		return Err(Error::from_reason(scan_limit_error(
			root,
			"collect",
			"transaction",
			policy.max_entries,
			"unsettled",
		)));
	}
	state.entries.sort_unstable_by(|a, b| a.path.cmp(&b.path));
	Ok(Arc::new(std::mem::take(&mut state.entries)))
}
fn collect_entries(
	root: &Path,
	options: ScanOptions,
	ct: &task::CancelToken,
) -> Result<Arc<Vec<GlobMatch>>> {
	collect_entries_with_policy(root, options, ct, scan_policy()?)
}

#[derive(Clone, Copy)]
struct EntryMetadata {
	file_type: FileType,
	mtime:     Option<f64>,
	size:      Option<f64>,
}

fn collect_entry_metadata(entry: &ignore::DirEntry, detail: ScanDetail) -> Option<EntryMetadata> {
	let path = entry.path();
	let (file_type, mtime, size) = match detail {
		ScanDetail::Minimal => (entry.file_type().and_then(file_type_from_std)?, None, None),
		ScanDetail::Full => {
			let metadata = entry
				.metadata()
				.or_else(|_| std::fs::symlink_metadata(path))
				.ok()?;
			let file_type = file_type_from_std(metadata.file_type())?;
			(
				file_type,
				mtime_ms(&metadata),
				(file_type == FileType::File).then_some(metadata.len() as f64),
			)
		},
	};
	Some(EntryMetadata { file_type, mtime, size })
}

fn collect_entry(
	relative: &Path,
	path_capacity: usize,
	metadata: EntryMetadata,
) -> std::result::Result<GlobMatch, ()> {
	let normalized = normalized_relative_path_fallible(relative, path_capacity)?;
	Ok(GlobMatch {
		path:      normalized,
		file_type: metadata.file_type,
		mtime:     metadata.mtime,
		size:      metadata.size,
	})
}

// ═══════════════════════════════════════════════════════════════════════════
// Cache API
// ═══════════════════════════════════════════════════════════════════════════

fn get_or_scan_with<F>(
	cache: &Mutex<CacheState>,
	key: CacheKey,
	policy: ScanPolicy,
	ttl: Duration,
	scan: F,
) -> Result<ScanResult>
where
	F: FnOnce() -> Result<Arc<Vec<GlobMatch>>>,
{
	if ttl.is_zero() || policy.cache_bytes == 0 {
		return Ok(ScanResult { entries: scan()?, cache_age_ms: 0 });
	}
	let now = Instant::now();
	let generation = {
		let mut state = cache.lock();
		if let Some(entry) = state.entries.get(&key) {
			let age = now.saturating_duration_since(entry.created_at);
			if age < ttl {
				return Ok(ScanResult {
					entries:      Arc::clone(&entry.entries),
					cache_age_ms: age.as_millis() as u64,
				});
			}
		}
		remove_entry(&mut state, &key);
		state.generation
	};
	let entries = scan()?;
	let completed_at = Instant::now();
	let mut state = cache.lock();
	let entries =
		publish_or_adopt(&mut state, generation, key.clone(), completed_at, ttl, entries, policy);
	let cache_age_ms = state
		.entries
		.get(&key)
		.filter(|entry| Arc::ptr_eq(&entry.entries, &entries))
		.map_or(0, |entry| {
			Instant::now()
				.saturating_duration_since(entry.created_at)
				.as_millis() as u64
		});
	Ok(ScanResult { entries, cache_age_ms })
}

/// Returns scanned entries using the global TTL cache policy.
pub fn get_or_scan(
	root: &Path,
	options: ScanOptions,
	ct: &task::CancelToken,
) -> Result<ScanResult> {
	let policy = scan_policy()?;
	get_or_scan_with(
		&FS_CACHE,
		cache_key(root, options),
		policy,
		Duration::from_millis(*CACHE_TTL_MS),
		|| collect_entries(root, options, ct),
	)
}

/// Force a fresh scan, replacing any existing cache entry.
pub fn force_rescan(
	root: &Path,
	options: ScanOptions,
	store: bool,
	ct: &task::CancelToken,
) -> Result<Arc<Vec<GlobMatch>>> {
	let policy = scan_policy()?;
	let key = cache_key(root, options);
	let generation = {
		let mut state = FS_CACHE.lock();
		remove_entry(&mut state, &key);
		advance_generation(&mut state);
		state.generation
	};
	let entries = collect_entries(root, options, ct)?;
	if store {
		let mut state = FS_CACHE.lock();
		publish_if_current(&mut state, generation, key, Instant::now(), Arc::clone(&entries), policy);
	}
	Ok(entries)
}

// ═══════════════════════════════════════════════════════════════════════════
// Invalidation
// ═══════════════════════════════════════════════════════════════════════════

/// Invalidate cache entries whose root contains `target`.
pub fn invalidate_path(target: &Path) {
	let mut state = FS_CACHE.lock();
	let keys: Vec<CacheKey> = state
		.entries
		.keys()
		.filter(|key| target.starts_with(&key.root))
		.cloned()
		.collect();
	for key in keys {
		remove_entry(&mut state, &key);
	}
	advance_generation(&mut state);
}

/// Clear the entire scan cache.
pub fn invalidate_all() {
	let mut state = FS_CACHE.lock();
	state.entries.clear();
	state.bytes = 0;
	advance_generation(&mut state);
}

/// Invalidate the filesystem scan cache.
///
/// When called with a path, removes entries for roots containing that path.
/// When called without a path, clears the entire cache.
///
/// Intended to be called after agent file mutations (write, edit, rename,
/// delete).
#[napi]
pub fn invalidate_fs_scan_cache(path: Option<String>) {
	match path {
		Some(p) => {
			let candidate = PathBuf::from(&p);
			let absolute = if candidate.is_absolute() {
				candidate
			} else if let Ok(cwd) = std::env::current_dir() {
				cwd.join(candidate)
			} else {
				PathBuf::from(&p)
			};
			let target = std::fs::canonicalize(&absolute)
				.or_else(|_| {
					absolute
						.parent()
						.and_then(|parent| std::fs::canonicalize(parent).ok())
						.and_then(|parent| absolute.file_name().map(|name| parent.join(name)))
						.ok_or_else(|| std::io::Error::from(std::io::ErrorKind::NotFound))
				})
				.unwrap_or(absolute);
			invalidate_path(&target);
		},
		None => invalidate_all(),
	}
}

#[cfg(test)]
mod tests {
	#[cfg(unix)]
	use std::{ffi::CString, os::unix::ffi::OsStrExt};
	use std::{
		fs,
		path::{Path, PathBuf},
		sync::atomic::{AtomicU64, Ordering},
		time::{Duration, SystemTime, UNIX_EPOCH},
	};

	use super::classify_file_type;

	static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

	struct TempDirGuard(PathBuf);

	impl TempDirGuard {
		fn new() -> Self {
			let timestamp = SystemTime::now()
				.duration_since(UNIX_EPOCH)
				.expect("system time is after UNIX_EPOCH")
				.as_nanos();
			let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
			let path = std::env::temp_dir().join(format!("pi-fs-cache-test-{timestamp}-{counter}"));
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

	#[cfg(unix)]
	fn make_fifo(path: &Path) {
		let fifo_path =
			CString::new(path.as_os_str().as_bytes()).expect("fifo path has no NUL bytes");
		// SAFETY: `fifo_path` is a valid CString (NUL-terminated, no interior NULs),
		// so `as_ptr()` yields a valid C string pointer. `0o600` is a valid mode.
		// The CString is alive for the duration of the call.
		let rc = unsafe { libc::mkfifo(fifo_path.as_ptr(), 0o600) };
		assert_eq!(rc, 0, "create fifo: {}", std::io::Error::last_os_error());
	}

	#[cfg(unix)]
	#[test]
	fn classify_file_type_skips_fifo() {
		let root = TempDirGuard::new();
		let fifo = root.path().join("skip-me.fifo");
		make_fifo(&fifo);

		assert_eq!(classify_file_type(&fifo), None);
	}

	#[test]
	fn build_walker_skips_git_and_node_modules() {
		let root = TempDirGuard::new();
		fs::create_dir_all(root.path().join(".git/objects")).unwrap();
		fs::write(root.path().join(".git/objects/a.txt"), "git obj").unwrap();
		fs::create_dir_all(root.path().join("node_modules/pkg")).unwrap();
		fs::write(root.path().join("node_modules/pkg/index.js"), "nm").unwrap();
		fs::write(root.path().join("real.txt"), "ok").unwrap();

		// skip_node_modules: true -> should only see real.txt
		let walker = super::build_walker(root.path(), true, false, true, false);
		let paths: Vec<String> = walker
			.build()
			.filter_map(|e| e.ok())
			.filter(|e| e.path() != root.path())
			.map(|e| {
				e.path()
					.strip_prefix(root.path())
					.unwrap()
					.to_string_lossy()
					.into_owned()
			})
			.collect();
		assert!(
			!paths
				.iter()
				.any(|p| p.contains("node_modules") || p.contains(".git")),
			"expected no .git or node_modules entries, got: {paths:?}"
		);
		assert!(paths.iter().any(|p| p == "real.txt"), "expected real.txt, got: {paths:?}");

		// skip_node_modules: false -> should see node_modules but not .git
		let walker = super::build_walker(root.path(), true, false, false, false);
		let paths: Vec<String> = walker
			.build()
			.filter_map(|e| e.ok())
			.filter(|e| e.path() != root.path())
			.map(|e| {
				e.path()
					.strip_prefix(root.path())
					.unwrap()
					.to_string_lossy()
					.into_owned()
			})
			.collect();
		assert!(
			!paths.iter().any(|p| p.contains(".git")),
			"expected no .git entries, got: {paths:?}"
		);
		assert!(
			paths.iter().any(|p| p.contains("node_modules")),
			"expected node_modules entries, got: {paths:?}"
		);
	}

	#[test]
	fn collect_entries_skips_node_modules() {
		let root = TempDirGuard::new();
		fs::create_dir_all(root.path().join("node_modules/pkg")).unwrap();
		fs::write(root.path().join("node_modules/pkg/index.js"), "nm").unwrap();
		fs::write(root.path().join("real.txt"), "ok").unwrap();

		let ct = crate::task::CancelToken::default();
		let entries = super::collect_entries(
			root.path(),
			super::ScanOptions {
				include_hidden:    true,
				use_gitignore:     false,
				skip_node_modules: true,
				follow_links:      false,
				detail:            super::ScanDetail::Full,
			},
			&ct,
		)
		.unwrap();
		let paths: Vec<&str> = entries.iter().map(|e| e.path.as_str()).collect();
		assert!(
			!paths.iter().any(|p| p.contains("node_modules")),
			"expected no node_modules entries, got: {paths:?}"
		);
		assert!(paths.iter().any(|p| p == &"real.txt"), "expected real.txt, got: {paths:?}");
	}

	#[test]
	fn collect_entries_respects_pre_cancelled_token() {
		let root = TempDirGuard::new();
		fs::write(root.path().join("real.txt"), "ok").unwrap();

		let ct = crate::task::CancelToken::new(Some(0), None);
		std::thread::sleep(Duration::from_millis(1));
		let result = super::collect_entries(
			root.path(),
			super::ScanOptions {
				include_hidden:    true,
				use_gitignore:     false,
				skip_node_modules: true,
				follow_links:      false,
				detail:            super::ScanDetail::Minimal,
			},
			&ct,
		);

		let Err(err) = result else {
			panic!("pre-cancelled scans should fail before returning entries");
		};
		assert!(
			err.to_string().contains("Timeout"),
			"expected timeout cancellation error, got: {err}"
		);
	}

	#[test]
	fn force_rescan_respects_skip_node_modules() {
		let root = TempDirGuard::new();
		// Create a nested node_modules with many files
		for i in 0..100 {
			let pkg_dir = root.path().join(format!("node_modules/pkg-{i}"));
			fs::create_dir_all(&pkg_dir).unwrap();
			fs::write(pkg_dir.join("index.js"), "x").unwrap();
		}
		fs::write(root.path().join("app.js"), "ok").unwrap();

		let ct = crate::task::CancelToken::default();

		// With skip: should only get app.js
		let entries = super::force_rescan(
			root.path(),
			super::ScanOptions {
				include_hidden:    true,
				use_gitignore:     false,
				skip_node_modules: true,
				follow_links:      false,
				detail:            super::ScanDetail::Full,
			},
			false,
			&ct,
		)
		.unwrap();
		assert_eq!(entries.len(), 1, "skip=true got: {}", entries.len());
		assert_eq!(entries[0].path, "app.js");

		// Without skip: should get app.js + 100 node_modules files + directories
		let entries = super::force_rescan(
			root.path(),
			super::ScanOptions {
				include_hidden:    true,
				use_gitignore:     false,
				skip_node_modules: false,
				follow_links:      false,
				detail:            super::ScanDetail::Full,
			},
			false,
			&ct,
		)
		.unwrap();
		assert!(entries.len() > 100, "skip=false got: {}", entries.len());
	}

	#[test]
	fn scan_detail_controls_metadata_collection() {
		let root = TempDirGuard::new();
		fs::write(root.path().join("real.txt"), "ok").unwrap();

		let ct = crate::task::CancelToken::default();
		let minimal = super::collect_entries(
			root.path(),
			super::ScanOptions {
				include_hidden:    true,
				use_gitignore:     false,
				skip_node_modules: true,
				follow_links:      false,
				detail:            super::ScanDetail::Minimal,
			},
			&ct,
		)
		.unwrap();
		let minimal_file = minimal
			.iter()
			.find(|entry| entry.path == "real.txt")
			.expect("minimal scan includes file");
		assert_eq!(minimal_file.mtime, None);
		assert_eq!(minimal_file.size, None);

		let full = super::collect_entries(
			root.path(),
			super::ScanOptions {
				include_hidden:    true,
				use_gitignore:     false,
				skip_node_modules: true,
				follow_links:      false,
				detail:            super::ScanDetail::Full,
			},
			&ct,
		)
		.unwrap();
		let full_file = full
			.iter()
			.find(|entry| entry.path == "real.txt")
			.expect("full scan includes file");
		assert!(full_file.mtime.is_some(), "full scan should include mtime");
		assert_eq!(full_file.size, Some(2.0));
	}

	fn options() -> super::ScanOptions {
		super::ScanOptions {
			include_hidden:    false,
			use_gitignore:     false,
			skip_node_modules: true,
			follow_links:      false,
			detail:            super::ScanDetail::Minimal,
		}
	}

	fn glob_match(path: &str) -> super::GlobMatch {
		super::GlobMatch {
			path:      path.to_string(),
			file_type: super::FileType::File,
			mtime:     None,
			size:      None,
		}
	}
	fn policy(max_entries: usize, max_bytes: usize) -> super::ScanPolicy {
		super::ScanPolicy {
			max_entries,
			max_bytes,
			cache_entries: 16,
			cache_bytes: 128 * 1024 * 1024,
		}
	}

	fn collector() -> super::CollectorState {
		super::CollectorState {
			entries:                Vec::new(),
			charged_bytes:          0,
			reserved_entries:       0,
			claimed_slots:          0,
			charged_capacity_slots: 0,
			terminal:               None,
		}
	}

	#[test]
	fn strict_limit_parser_covers_boundaries_and_invalid_values() {
		assert_eq!(super::parse_limit_value("LIMIT", None, 17, 10, 20, false), Ok(17));
		assert_eq!(super::parse_limit_value("LIMIT", Some("10"), 17, 10, 20, false), Ok(10));
		assert_eq!(super::parse_limit_value("LIMIT", Some("20"), 17, 10, 20, false), Ok(20));
		assert_eq!(super::parse_limit_value("LIMIT", Some("0"), 17, 10, 20, true), Ok(0));

		for (value, reason) in [
			("nope", "malformed"),
			("-1", "signed"),
			("+10", "signed"),
			("0", "zero"),
			("9", "below_min"),
			("21", "above_max"),
		] {
			let error = super::parse_limit_value("LIMIT", Some(value), 17, 10, 20, false)
				.expect_err("invalid explicit limit must fail");
			assert!(error.contains(&format!("reason={reason}")), "{error}");
			assert!(error.len() < 512, "configuration diagnostics must stay bounded");
		}

		let overflow = (usize::MAX as u128 + 1).to_string();
		let error = super::parse_limit_value("LIMIT", Some(&overflow), 17, 10, usize::MAX, false)
			.expect_err("usize overflow must fail");
		assert!(error.contains("reason=overflow"), "{error}");

		let beyond_u128 = "9".repeat(128);
		let error = super::parse_limit_value("LIMIT", Some(&beyond_u128), 17, 10, usize::MAX, false)
			.expect_err("u128 overflow must fail");
		assert!(error.contains("reason=overflow"), "{error}");

		let unicode = "가".repeat(256);
		let error = super::parse_limit_value("LIMIT", Some(&unicode), 17, 10, 20, false)
			.expect_err("malformed unicode limit must fail");
		assert!(error.contains("reason=malformed"), "{error}");
		assert!(error.len() < 512, "unicode diagnostics must truncate on character boundaries");
	}

	#[test]
	fn collector_entry_and_byte_boundaries_are_exact() {
		let root = Path::new("/root");
		let path = Path::new("a");
		let path_bytes = super::normalized_path_capacity(Path::new("a")).unwrap();
		let mut entry_bounded = collector();
		assert!(
			entry_bounded
				.begin_candidate(root, path, policy(1, usize::MAX))
				.is_ok()
		);
		assert_eq!(entry_bounded.reserved_entries, 1);
		assert!(entry_bounded.charged_bytes >= path_bytes + std::mem::size_of::<super::GlobMatch>());
		assert!(
			entry_bounded
				.begin_candidate(root, Path::new("b"), policy(1, usize::MAX))
				.is_err()
		);
		assert!(
			entry_bounded
				.terminal
				.as_deref()
				.is_some_and(|error| error.contains("dimension=entries"))
		);

		let mut capacity_probe = collector();
		assert!(
			capacity_probe
				.begin_candidate(root, path, policy(64, usize::MAX))
				.is_ok()
		);
		assert!(capacity_probe.charged_capacity_slots >= 64);
		let geometric_bytes = capacity_probe.charged_bytes;

		let mut geometric = collector();
		assert!(
			geometric
				.begin_candidate(root, path, policy(64, geometric_bytes))
				.is_ok()
		);
		assert_eq!(geometric.charged_bytes, geometric_bytes);
		assert_eq!(geometric.charged_capacity_slots, capacity_probe.charged_capacity_slots);

		let minimum_bytes = path_bytes + std::mem::size_of::<super::GlobMatch>();
		let mut exact = collector();
		assert!(
			exact
				.begin_candidate(root, path, policy(64, minimum_bytes))
				.is_ok()
		);
		assert_eq!(exact.charged_bytes, minimum_bytes);
		assert_eq!(exact.charged_capacity_slots, 1);

		let mut one_under = collector();
		assert!(
			one_under
				.begin_candidate(root, path, policy(64, minimum_bytes - 1))
				.is_err()
		);
		assert_eq!(one_under.reserved_entries, 0, "failed admission rolls back logical count");
		assert_eq!(one_under.charged_bytes, 0, "failed admission rolls back path charge");
		assert_eq!(one_under.claimed_slots, 0);
		assert!(
			one_under
				.terminal
				.as_deref()
				.is_some_and(|error| error.contains("dimension=bytes"))
		);
	}

	#[test]
	fn provisional_claim_barrier_uses_length_relative_reservation() {
		let mut entries = Vec::with_capacity(8);
		entries.push(glob_match("a"));
		let old_capacity = entries.capacity();
		let mut state = super::CollectorState {
			charged_bytes: old_capacity * std::mem::size_of::<super::GlobMatch>()
				+ entries[0].path.capacity(),
			reserved_entries: 1,
			claimed_slots: old_capacity - 1,
			charged_capacity_slots: old_capacity,
			entries,
			terminal: None,
		};
		let max_entries = old_capacity * 2;
		state
			.claim_slot(Path::new("/root"), policy(max_entries, usize::MAX))
			.expect("a saturated provisional barrier must grow");
		assert_eq!(state.claimed_slots, old_capacity);
		assert!(
			state.charged_capacity_slots >= state.entries.len() + state.claimed_slots,
			"every committed or provisional element must own a distinct charged slot"
		);
		assert!(
			state.charged_capacity_slots >= max_entries,
			"reserve_exact must receive requested_target - entries.len()"
		);
	}

	#[test]
	fn provisional_claim_barrier_uses_affordable_tail_capacity() {
		let mut capacity_probe = Vec::with_capacity(8);
		capacity_probe.push(glob_match("a"));
		let old_capacity = capacity_probe.capacity();
		let new_state = || {
			let mut entries = Vec::with_capacity(old_capacity);
			entries.push(glob_match("a"));
			let charged_bytes =
				old_capacity * std::mem::size_of::<super::GlobMatch>() + entries[0].path.capacity();
			(
				super::CollectorState {
					charged_bytes,
					reserved_entries: 1,
					claimed_slots: old_capacity - 1,
					charged_capacity_slots: old_capacity,
					entries,
					terminal: None,
				},
				charged_bytes,
			)
		};
		let one_slot_bytes = std::mem::size_of::<super::GlobMatch>();

		let (mut exact, charged_bytes) = new_state();
		exact
			.claim_slot(Path::new("/root"), policy(old_capacity * 2, charged_bytes + one_slot_bytes))
			.expect("the minimum required tail slot must be admitted");
		assert_eq!(exact.claimed_slots, old_capacity);
		assert_eq!(exact.charged_capacity_slots, old_capacity + 1);
		assert_eq!(exact.charged_bytes, charged_bytes + one_slot_bytes);

		let (mut one_under, charged_bytes) = new_state();
		assert!(
			one_under
				.claim_slot(
					Path::new("/root"),
					policy(old_capacity * 2, charged_bytes + one_slot_bytes - 1),
				)
				.is_err()
		);
		assert_eq!(one_under.claimed_slots, old_capacity - 1);
		assert_eq!(one_under.charged_capacity_slots, old_capacity);
		assert_eq!(one_under.charged_bytes, charged_bytes);
		assert!(
			one_under
				.terminal
				.as_deref()
				.is_some_and(|error| error.contains("dimension=bytes"))
		);
	}

	#[test]
	fn collector_terminal_error_is_write_once_and_blocks_late_admission() {
		let mut state = collector();
		state.fail("first".to_string());
		state.fail("second".to_string());
		let before = (state.reserved_entries, state.charged_bytes, state.claimed_slots);
		assert!(
			state
				.begin_candidate(Path::new("/root"), Path::new("late"), policy(64, usize::MAX))
				.is_err()
		);
		assert_eq!(state.terminal.as_deref(), Some("first"));
		assert_eq!((state.reserved_entries, state.charged_bytes, state.claimed_slots), before);
	}

	#[test]
	fn over_budget_collection_returns_no_snapshot() {
		let root = TempDirGuard::new();
		for name in ["a.txt", "b.txt", "c.txt"] {
			fs::write(root.path().join(name), name).unwrap();
		}
		let result = super::collect_entries_with_policy(
			root.path(),
			options(),
			&crate::task::CancelToken::default(),
			policy(1, 1024 * 1024),
		);
		let Err(error) = result else {
			panic!("a scan above the entry limit must not return a snapshot");
		};
		assert!(error.to_string().contains("dimension=entries"), "{error}");
	}

	#[cfg(unix)]
	#[test]
	fn fallible_normalization_preserves_lossy_utf8_without_overallocation() {
		use std::{ffi::OsString, os::unix::ffi::OsStringExt};
		let relative = PathBuf::from(OsString::from_vec(vec![b'a', 0xff, b'/', b'b']));
		let charged = super::normalized_path_capacity(&relative).unwrap();
		let normalized = super::normalized_relative_path_fallible(&relative, charged).unwrap();
		assert_eq!(normalized, "a\u{fffd}/b");
		assert!(normalized.capacity() <= charged);
	}

	#[test]
	fn snapshot_accounting_uses_capacity() {
		let mut collected = Vec::with_capacity(4);
		collected.push(glob_match("a/b.txt"));
		let expected = collected.capacity() * std::mem::size_of::<super::GlobMatch>()
			+ collected[0].path.capacity();
		let entries = std::sync::Arc::new(collected);
		assert_eq!(super::snapshot_bytes(&entries), Some(expected));
	}

	#[test]
	fn cache_key_separates_follow_links() {
		let base = super::ScanOptions {
			include_hidden:    true,
			use_gitignore:     true,
			skip_node_modules: true,
			follow_links:      false,
			detail:            super::ScanDetail::Minimal,
		};
		let following = super::ScanOptions { follow_links: true, ..base };
		assert_ne!(
			super::cache_key(Path::new("/tmp"), base),
			super::cache_key(Path::new("/tmp"), following)
		);
	}

	#[test]
	fn publication_evicts_whole_snapshots() {
		let policy = super::ScanPolicy {
			max_entries:   10,
			max_bytes:     1024 * 1024,
			cache_entries: 1,
			cache_bytes:   1024 * 1024,
		};
		let entries = std::sync::Arc::new(vec![glob_match("file.txt")]);
		let mut state = super::CacheState::default();
		super::publish(
			&mut state,
			super::cache_key(Path::new("/a"), options()),
			std::time::Instant::now(),
			std::sync::Arc::clone(&entries),
			policy,
		);
		super::publish(
			&mut state,
			super::cache_key(Path::new("/b"), options()),
			std::time::Instant::now(),
			entries,
			policy,
		);
		assert_eq!(state.entries.len(), 1);
		assert!(
			state
				.entries
				.contains_key(&super::cache_key(Path::new("/b"), options()))
		);
	}
	#[test]
	fn cache_budget_boundary_and_normal_miss_adoption_share_arc() {
		let key = super::cache_key(Path::new("/shared"), options());
		let first = std::sync::Arc::new(vec![glob_match("first.txt")]);
		let bytes = super::snapshot_bytes(&first).unwrap();
		let mut exact_policy = policy(10, usize::MAX);
		exact_policy.cache_bytes = bytes;
		let mut state = super::CacheState::default();
		assert!(super::publish(
			&mut state,
			key.clone(),
			std::time::Instant::now(),
			std::sync::Arc::clone(&first),
			exact_policy,
		));
		assert_eq!(state.bytes, bytes);

		let contender = std::sync::Arc::new(vec![glob_match("contender.txt")]);
		let generation = state.generation;
		let adopted = super::publish_or_adopt(
			&mut state,
			generation,
			key,
			std::time::Instant::now(),
			std::time::Duration::from_secs(1),
			contender,
			exact_policy,
		);
		assert!(std::sync::Arc::ptr_eq(&adopted, &first));

		let mut too_small = super::CacheState::default();
		let mut one_under_policy = exact_policy;
		one_under_policy.cache_bytes = bytes - 1;
		assert!(!super::publish(
			&mut too_small,
			super::cache_key(Path::new("/too-large"), options()),
			std::time::Instant::now(),
			first,
			one_under_policy,
		));
		assert!(too_small.entries.is_empty());
		assert_eq!(too_small.bytes, 0);
	}

	#[test]
	fn zero_cache_budget_disables_publication() {
		let mut no_cache = policy(10, usize::MAX);
		no_cache.cache_bytes = 0;
		let mut state = super::CacheState::default();
		assert!(!super::publish(
			&mut state,
			super::cache_key(Path::new("/disabled"), options()),
			std::time::Instant::now(),
			std::sync::Arc::new(Vec::new()),
			no_cache,
		));
		assert!(state.entries.is_empty());
		assert_eq!(state.bytes, 0);
	}

	#[test]
	fn expired_same_generation_winner_is_replaced_at_scan_completion() {
		let key = super::cache_key(Path::new("/ttl-race"), options());
		let mut state = super::CacheState::default();
		let base = std::time::Instant::now();
		let ttl = std::time::Duration::from_millis(10);
		let stale = std::sync::Arc::new(vec![glob_match("stale.txt")]);
		assert!(super::publish(&mut state, key.clone(), base, stale, policy(10, usize::MAX),));

		let completed_at = base + ttl + std::time::Duration::from_millis(1);
		let fresh = std::sync::Arc::new(vec![glob_match("fresh.txt")]);
		let generation = state.generation;
		let published = super::publish_or_adopt(
			&mut state,
			generation,
			key.clone(),
			completed_at,
			ttl,
			std::sync::Arc::clone(&fresh),
			policy(10, usize::MAX),
		);
		assert!(std::sync::Arc::ptr_eq(&published, &fresh));
		let cached = state
			.entries
			.get(&key)
			.expect("fresh completion must replace expired winner");
		assert!(std::sync::Arc::ptr_eq(&cached.entries, &fresh));
		assert_eq!(cached.created_at, completed_at);

		let later = std::sync::Arc::new(vec![glob_match("later.txt")]);
		let adopted = super::publish_or_adopt(
			&mut state,
			generation,
			key,
			completed_at + std::time::Duration::from_millis(1),
			ttl,
			later,
			policy(10, usize::MAX),
		);
		assert!(std::sync::Arc::ptr_eq(&adopted, &fresh));
	}

	#[test]
	fn get_or_scan_flow_rejects_an_expired_concurrent_winner() {
		let cache = std::sync::Arc::new(parking_lot::Mutex::new(super::CacheState::default()));
		let key = super::cache_key(Path::new("/ttl-flow-race"), options());
		let scan_policy = policy(10, usize::MAX);
		let ttl = std::time::Duration::from_millis(10);
		let started = std::sync::Arc::new(std::sync::Barrier::new(3));
		let release_first = std::sync::Arc::new(std::sync::Barrier::new(2));
		let release_second = std::sync::Arc::new(std::sync::Barrier::new(2));

		let first_cache = std::sync::Arc::clone(&cache);
		let first_key = key.clone();
		let first_started = std::sync::Arc::clone(&started);
		let first_release = std::sync::Arc::clone(&release_first);
		let first = std::thread::spawn(move || {
			super::get_or_scan_with(&first_cache, first_key, scan_policy, ttl, || {
				first_started.wait();
				first_release.wait();
				Ok(std::sync::Arc::new(vec![glob_match("first.txt")]))
			})
			.expect("first scan succeeds")
			.entries
		});

		let second_cache = std::sync::Arc::clone(&cache);
		let second_key = key.clone();
		let second_started = std::sync::Arc::clone(&started);
		let second_release = std::sync::Arc::clone(&release_second);
		let second = std::thread::spawn(move || {
			super::get_or_scan_with(&second_cache, second_key, scan_policy, ttl, || {
				second_started.wait();
				second_release.wait();
				Ok(std::sync::Arc::new(vec![glob_match("second.txt")]))
			})
			.expect("second scan succeeds")
			.entries
		});

		started.wait();
		release_first.wait();
		let first_entries = first.join().expect("first scan thread joins");
		assert_eq!(first_entries[0].path, "first.txt");

		std::thread::sleep(ttl + std::time::Duration::from_millis(10));
		release_second.wait();
		let second_entries = second.join().expect("second scan thread joins");
		assert_eq!(second_entries[0].path, "second.txt");
		assert!(!std::sync::Arc::ptr_eq(&first_entries, &second_entries));

		let state = cache.lock();
		let cached = state
			.entries
			.get(&key)
			.expect("second completion must replace expired winner");
		assert!(std::sync::Arc::ptr_eq(&cached.entries, &second_entries));
	}

	#[test]
	fn invalidation_generation_blocks_stale_publication_and_later_force_wins() {
		let key = super::cache_key(Path::new("/race"), options());
		let mut state = super::CacheState::default();
		let normal_generation = state.generation;
		super::advance_generation(&mut state);
		let force_generation = state.generation;
		let forced = std::sync::Arc::new(vec![glob_match("forced.txt")]);
		assert!(super::publish_if_current(
			&mut state,
			force_generation,
			key.clone(),
			std::time::Instant::now(),
			std::sync::Arc::clone(&forced),
			policy(10, usize::MAX),
		));
		assert!(!super::publish_if_current(
			&mut state,
			normal_generation,
			key.clone(),
			std::time::Instant::now(),
			std::sync::Arc::new(vec![glob_match("stale-normal.txt")]),
			policy(10, usize::MAX),
		));
		assert!(std::sync::Arc::ptr_eq(&state.entries.get(&key).unwrap().entries, &forced));

		super::advance_generation(&mut state);
		let later_generation = state.generation;
		let later = std::sync::Arc::new(vec![glob_match("later-force.txt")]);
		assert!(super::publish_if_current(
			&mut state,
			later_generation,
			key.clone(),
			std::time::Instant::now(),
			std::sync::Arc::clone(&later),
			policy(10, usize::MAX),
		));
		assert!(!super::publish_if_current(
			&mut state,
			force_generation,
			key.clone(),
			std::time::Instant::now(),
			forced,
			policy(10, usize::MAX),
		));
		assert!(std::sync::Arc::ptr_eq(&state.entries.get(&key).unwrap().entries, &later));

		super::remove_entry(&mut state, &key);
		assert!(state.entries.is_empty());
		assert_eq!(state.bytes, 0, "whole-snapshot removal must subtract retained bytes");
	}

	#[test]
	fn generation_overflow_clears_cache_and_disables_publication() {
		let mut state = super::CacheState::default();
		let entries = std::sync::Arc::new(vec![glob_match("file.txt")]);
		assert!(super::publish(
			&mut state,
			super::cache_key(Path::new("/cached"), options()),
			std::time::Instant::now(),
			entries,
			policy(10, usize::MAX),
		));
		state.generation = u64::MAX;
		super::advance_generation(&mut state);
		assert!(state.publication_disabled);
		assert_eq!(state.generation, u64::MAX);
		assert!(state.entries.is_empty());
		assert_eq!(state.bytes, 0);
		assert!(!super::publish(
			&mut state,
			super::cache_key(Path::new("/disabled"), options()),
			std::time::Instant::now(),
			std::sync::Arc::new(vec![glob_match("ignored.txt")]),
			policy(10, usize::MAX),
		));
	}
}
