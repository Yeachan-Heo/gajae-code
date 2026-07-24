//! Workspace discovery for startup context.
//!
//! Walks a project tree once and returns the bounded entries needed to render
//! the workspace tree plus directory-scoped AGENTS.md files. AGENTS.md files
//! are checked directly in every traversed directory so a file-level gitignore
//! rule cannot hide them, while ignored directories are still pruned by the
//! walker.

use std::{
	collections::HashSet,
	path::{Path, PathBuf},
	sync::{Arc, LazyLock},
};

use ignore::{DirEntry, ParallelVisitor, ParallelVisitorBuilder, WalkBuilder, WalkState};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use parking_lot::Mutex;

use crate::{
	fs_cache::{self, FileType, GlobMatch},
	task,
};

const AGENTS_MD_FILENAME: &str = "AGENTS.md";
const AGENTS_MD_MIN_DEPTH: usize = 1;
const AGENTS_MD_MAX_DEPTH: usize = 4;
const AGENTS_MD_LIMIT: usize = 200;
const MAX_ENTRIES: usize = 100_000;

/// Directory names pruned during traversal. The TypeScript caller no longer has
/// to plumb this list through; it lives here so a single source of truth
/// governs what counts as a non-source directory in startup scans.
const EXCLUDED_DIRS: &[&str] = &[
	"node_modules",
	".git",
	".next",
	"dist",
	"build",
	"target",
	".venv",
	".cache",
	".turbo",
	".parcel-cache",
	"coverage",
];

static EXCLUDED_DIR_SET: LazyLock<HashSet<&'static str>> =
	LazyLock::new(|| EXCLUDED_DIRS.iter().copied().collect());

/// Input options for `listWorkspace`, the single-pass workspace startup scan.
#[napi(object)]
pub struct ListWorkspaceOptions<'env> {
	/// Directory to scan.
	pub path:              String,
	/// Maximum depth for returned tree entries. Root children are depth 1.
	pub max_depth:         u32,
	/// Include hidden files and directories. Default: false.
	pub hidden:            Option<bool>,
	/// Respect .gitignore files. Default: true.
	pub gitignore:         Option<bool>,
	/// Also surface AGENTS.md files in directories at depth 1..=4, even when
	/// gitignore would otherwise hide the file. Walks deeper than `maxDepth`
	/// to find them. Default: false.
	pub collect_agents_md: Option<bool>,
	/// Timeout in milliseconds for the operation.
	pub timeout_ms:        Option<u32>,
	/// Abort signal for cancelling the operation.
	pub signal:            Option<Unknown<'env>>,
}

/// Result payload returned by a workspace scan.
#[napi(object)]
pub struct ListWorkspaceResult {
	/// Entries within `maxDepth`, with mtime and regular-file size metadata.
	pub entries:         Vec<GlobMatch>,
	/// Directory-scoped AGENTS.md files within depth 1..=4 (capped at 200).
	/// Always empty when `collectAgentsMd` is false.
	pub agents_md_files: Vec<String>,
	/// True when any output cap was hit.
	pub truncated:       bool,
}

struct WorkspaceConfig {
	root:              PathBuf,
	max_depth:         usize,
	walk_max_depth:    usize,
	include_hidden:    bool,
	use_gitignore:     bool,
	collect_agents_md: bool,
}

fn build_workspace_walker(config: &WorkspaceConfig) -> WalkBuilder {
	let mut builder = WalkBuilder::new(&config.root);
	builder
		.hidden(!config.include_hidden)
		.follow_links(false)
		.sort_by_file_path(|a, b| a.cmp(b))
		.max_depth(Some(config.walk_max_depth))
		.filter_entry(|entry| {
			let name = entry.file_name().to_str().unwrap_or_default();
			if name == ".DS_Store" {
				return false;
			}
			if entry
				.file_type()
				.is_some_and(|file_type| file_type.is_dir())
				&& EXCLUDED_DIR_SET.contains(name)
			{
				return false;
			}
			true
		});

	if config.use_gitignore {
		builder
			.git_ignore(true)
			.git_exclude(true)
			.git_global(true)
			.ignore(true)
			.parents(true)
			// Honor .gitignore even when the directory isn't a git repo,
			// matching what users expect from a plain directory listing.
			.require_git(false);
	} else {
		builder
			.git_ignore(false)
			.git_exclude(false)
			.git_global(false)
			.ignore(false)
			.parents(false);
	}

	builder
}

fn glob_match_from_path(root: &Path, path: &Path) -> Option<GlobMatch> {
	let relative = fs_cache::normalize_relative_path(root, path);
	if relative.is_empty() {
		return None;
	}
	let (file_type, mtime, size) = fs_cache::classify_file_type(path)?;
	Some(GlobMatch {
		path: relative.into_owned(),
		file_type,
		mtime,
		size: size.map(|value| value as f64),
	})
}

fn glob_match_from_entry(root: &Path, entry: &DirEntry) -> Option<GlobMatch> {
	glob_match_from_path(root, entry.path())
}

fn is_file_or_file_symlink(path: &Path, file_type: FileType) -> bool {
	match file_type {
		FileType::File => true,
		FileType::Symlink => std::fs::metadata(path).is_ok_and(|metadata| metadata.is_file()),
		FileType::Dir => false,
	}
}

fn collect_agents_md_in_directory(
	config: &WorkspaceConfig,
	directory: &Path,
	directory_depth: usize,
	entries: &mut Vec<GlobMatch>,
	agents_md_files: &mut Vec<String>,
) {
	if !config.collect_agents_md {
		return;
	}
	let candidate = directory.join(AGENTS_MD_FILENAME);
	let Some(entry) = glob_match_from_path(&config.root, &candidate) else {
		return;
	};
	if !is_file_or_file_symlink(&candidate, entry.file_type) {
		return;
	}
	let tree_depth = directory_depth + 1;
	if tree_depth <= config.max_depth {
		entries.push(entry.clone());
	}
	// AGENTS.md directory depth: root AGENTS.md is depth 0, child dir AGENTS.md
	// is depth 1, and so on. We only surface files in depth 1..=4.
	if (AGENTS_MD_MIN_DEPTH..=AGENTS_MD_MAX_DEPTH).contains(&directory_depth) {
		agents_md_files.push(entry.path);
	}
}

struct WorkspaceVisitor<'a> {
	config:                 &'a WorkspaceConfig,
	ct:                     &'a task::CancelToken,
	entries:                Vec<GlobMatch>,
	agents_md_files:        Vec<String>,
	shared_entries:         Arc<Mutex<Vec<Vec<GlobMatch>>>>,
	shared_agents_md_files: Arc<Mutex<Vec<Vec<String>>>>,
	error:                  Arc<Mutex<Option<String>>>,
	visited:                usize,
}

impl Drop for WorkspaceVisitor<'_> {
	fn drop(&mut self) {
		if !self.entries.is_empty() {
			let entries = std::mem::take(&mut self.entries);
			self.shared_entries.lock().push(entries);
		}
		if !self.agents_md_files.is_empty() {
			let agents_md_files = std::mem::take(&mut self.agents_md_files);
			self.shared_agents_md_files.lock().push(agents_md_files);
		}
	}
}

impl ParallelVisitor for WorkspaceVisitor<'_> {
	fn visit(&mut self, entry: std::result::Result<DirEntry, ignore::Error>) -> WalkState {
		if self.visited == 0 || self.visited >= 128 {
			self.visited = 0;
			if let Err(err) = self.ct.heartbeat() {
				*self.error.lock() = Some(err.to_string());
				return WalkState::Quit;
			}
		}
		self.visited += 1;

		let Ok(entry) = entry else {
			return WalkState::Continue;
		};
		let entry_depth = entry.depth();
		if entry
			.file_type()
			.is_some_and(|file_type| file_type.is_dir())
		{
			collect_agents_md_in_directory(
				self.config,
				entry.path(),
				entry_depth,
				&mut self.entries,
				&mut self.agents_md_files,
			);
		}
		if entry_depth <= self.config.max_depth
			&& let Some(entry) = glob_match_from_entry(&self.config.root, &entry)
		{
			self.entries.push(entry);
		}
		WalkState::Continue
	}
}

struct WorkspaceVisitorBuilder<'a> {
	config:                 &'a WorkspaceConfig,
	ct:                     &'a task::CancelToken,
	shared_entries:         Arc<Mutex<Vec<Vec<GlobMatch>>>>,
	shared_agents_md_files: Arc<Mutex<Vec<Vec<String>>>>,
	error:                  Arc<Mutex<Option<String>>>,
}

impl<'a> ParallelVisitorBuilder<'a> for WorkspaceVisitorBuilder<'a> {
	fn build(&mut self) -> Box<dyn ParallelVisitor + 'a> {
		Box::new(WorkspaceVisitor {
			config:                 self.config,
			ct:                     self.ct,
			entries:                Vec::new(),
			agents_md_files:        Vec::new(),
			shared_entries:         Arc::clone(&self.shared_entries),
			shared_agents_md_files: Arc::clone(&self.shared_agents_md_files),
			error:                  Arc::clone(&self.error),
			visited:                0,
		})
	}
}

fn sort_dedup_entries(entries: &mut Vec<GlobMatch>) {
	entries.sort_unstable_by(|a, b| a.path.cmp(&b.path));
	entries.dedup_by(|a, b| a.path == b.path);
}

fn sort_dedup_paths(paths: &mut Vec<String>) {
	paths.sort_unstable();
	paths.dedup();
}

fn run_list_workspace(
	config: WorkspaceConfig,
	ct: task::CancelToken,
) -> Result<ListWorkspaceResult> {
	let mut root_entries = Vec::new();
	let mut root_agents_md_files = Vec::new();
	collect_agents_md_in_directory(
		&config,
		&config.root,
		0,
		&mut root_entries,
		&mut root_agents_md_files,
	);

	let mut builder = build_workspace_walker(&config);
	let workers = fs_cache::grep_workers();
	if workers > 0 {
		builder.threads(workers);
	}

	let shared_entries = Arc::new(Mutex::new(Vec::new()));
	let shared_agents_md_files = Arc::new(Mutex::new(Vec::new()));
	let error = Arc::new(Mutex::new(None));
	let mut visitor_builder = WorkspaceVisitorBuilder {
		config:                 &config,
		ct:                     &ct,
		shared_entries:         Arc::clone(&shared_entries),
		shared_agents_md_files: Arc::clone(&shared_agents_md_files),
		error:                  Arc::clone(&error),
	};

	ct.heartbeat()?;
	builder.build_parallel().visit(&mut visitor_builder);

	let walk_error = error.lock().take();
	if let Some(error) = walk_error {
		return Err(Error::from_reason(error));
	}

	let mut entries: Vec<GlobMatch> = shared_entries.lock().drain(..).flatten().collect();
	entries.extend(root_entries);
	sort_dedup_entries(&mut entries);

	let mut agents_md_files: Vec<String> =
		shared_agents_md_files.lock().drain(..).flatten().collect();
	agents_md_files.extend(root_agents_md_files);
	sort_dedup_paths(&mut agents_md_files);

	let entries_truncated = entries.len() > MAX_ENTRIES;
	if entries_truncated {
		entries.truncate(MAX_ENTRIES);
	}
	let agents_md_truncated = agents_md_files.len() > AGENTS_MD_LIMIT;
	if agents_md_truncated {
		agents_md_files.truncate(AGENTS_MD_LIMIT);
	}

	Ok(ListWorkspaceResult {
		entries,
		agents_md_files,
		truncated: entries_truncated || agents_md_truncated,
	})
}

/// Walk the workspace once and return tree entries plus AGENTS.md candidates.
///
/// File-level ignore rules for AGENTS.md are bypassed by checking each
/// traversed directory directly when `collectAgentsMd` is enabled, but ignored
/// directories are still pruned by the walker and are not searched.
#[napi(js_name = "listWorkspace")]
pub fn list_workspace(options: ListWorkspaceOptions<'_>) -> task::Promise<ListWorkspaceResult> {
	let ListWorkspaceOptions {
		path,
		max_depth,
		hidden,
		gitignore,
		collect_agents_md,
		timeout_ms,
		signal,
	} = options;

	let ct = task::CancelToken::new(timeout_ms, signal);
	task::blocking("listWorkspace", ct, move |ct| {
		let max_depth = max_depth as usize;
		let collect_agents_md = collect_agents_md.unwrap_or(false);
		let walk_max_depth = if collect_agents_md {
			max_depth.max(AGENTS_MD_MAX_DEPTH)
		} else {
			max_depth
		};
		run_list_workspace(
			WorkspaceConfig {
				root: fs_cache::resolve_search_path(&path)?,
				max_depth,
				walk_max_depth,
				include_hidden: hidden.unwrap_or(false),
				use_gitignore: gitignore.unwrap_or(true),
				collect_agents_md,
			},
			ct,
		)
	})
}
