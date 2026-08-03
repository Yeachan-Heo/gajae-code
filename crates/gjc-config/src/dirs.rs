//! Centralized path helpers for gajae-code config directories.
//!
//! Port of `packages/utils/src/dirs.ts`.
//!
//! Uses `GJC_CONFIG_DIR` (legacy alias `PI_CONFIG_DIR`, default `.gjc`) for the
//! config root and `GJC_CODING_AGENT_DIR` (legacy alias `PI_CODING_AGENT_DIR`)
//! to override the agent directory. On Linux/macOS, when `XDG_DATA_HOME` /
//! `XDG_STATE_HOME` / `XDG_CACHE_HOME` point at an existing `<dir>/gjc`,
//! matching categories are redirected there (requires prior `gjc config
//! migrate`; no other existence checks are performed).
//!
//! Trust guard (mirrors `trustedConfigDirName` / `trustedAgentDirOverride`):
//! an env override whose value matches what the project `cwd/.env` sets is
//! rejected, because Bun-side the project `.env` is loaded into the process
//! environment before startup and could otherwise redirect the trusted config
//! root into attacker-controlled territory. The Rust binary keeps the same
//! rule so behavior is identical under any launcher that pre-loads `.env`.

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};

use crate::env_file::parse_env_file;

/// App name (e.g. `gjc`).
pub const APP_NAME: &str = "gjc";

/// Default config directory name (e.g. `.gjc`).
pub const CONFIG_DIR_NAME: &str = ".gjc";

/// XDG category for a path (mirrors the TS `XdgCategory` union).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Xdg {
	Data,
	State,
	Cache,
}

/// Inputs for directory resolution. Explicit (no globals) so tests and the
/// parity harness can construct arbitrary environments.
#[derive(Clone, Debug)]
pub struct DirsInput {
	pub home: PathBuf,
	pub cwd: PathBuf,
	pub env: HashMap<String, String>,
	/// Whether XDG redirection may apply (`linux`/`macos` in production).
	pub xdg_platform: bool,
}

impl DirsInput {
	/// Capture from the real process environment.
	pub fn from_process() -> anyhow::Result<Self> {
		let home =
			std::env::home_dir().ok_or_else(|| anyhow::anyhow!("cannot determine home directory"))?;
		Ok(Self {
			home,
			cwd: std::env::current_dir()?,
			env: std::env::vars().collect(),
			xdg_platform: cfg!(any(target_os = "linux", target_os = "macos")),
		})
	}

	/// Env override that is rejected when the project `cwd/.env` sets the
	/// identical value (conservative ambiguity rule; see module docs).
	fn trusted_env(&self, name: &str) -> Option<&str> {
		let value = self.env.get(name)?;
		if value.is_empty() {
			return None;
		}
		if parse_env_file(&self.cwd.join(".env")).get(name) == Some(value) {
			return None;
		}
		Some(value)
	}
}

/// Reject a configured config-directory name whose normalized form contains a
/// `..` segment (mirrors `sanitizeConfigDirName`).
fn sanitize_config_dir_name(value: &str) -> Option<&str> {
	let trimmed = value.trim();
	if trimmed.is_empty() {
		return None;
	}
	let escapes = Path::new(trimmed)
		.components()
		.any(|c| matches!(c, Component::ParentDir));
	if escapes { None } else { Some(trimmed) }
}

/// Join `name` beneath `base` even when `name` looks absolute
/// (Node `path.join` semantics: a leading separator does not re-root).
fn join_under(base: &Path, name: &str) -> PathBuf {
	let stripped = name.trim_start_matches(['/', '\\']);
	let mut out = base.to_path_buf();
	for part in stripped
		.split(['/', '\\'])
		.filter(|p| !p.is_empty() && *p != ".")
	{
		out.push(part);
	}
	out
}

/// Resolved, XDG-aware directory set (port of the TS `DirResolver`).
#[derive(Clone, Debug)]
pub struct Dirs {
	input: DirsInput,
	/// Config root (`~/.gjc`).
	pub config_root: PathBuf,
	/// Agent directory (`~/.gjc/agent` unless overridden).
	pub agent_dir: PathBuf,
	root_bases: [PathBuf; 3],  // data, state, cache
	agent_bases: [PathBuf; 3], // data, state, cache
}

impl Dirs {
	pub fn resolve(input: DirsInput) -> Self {
		let config_dir_name = Self::config_dir_name_from(&input);
		let config_root = join_under(&input.home, &config_dir_name);

		let default_agent = config_root.join("agent");
		let agent_dir = Self::agent_dir_override(&input)
			.map_or_else(|| default_agent.clone(), |o| absolutize(&input.cwd, Path::new(o)));
		let is_default = agent_dir == default_agent;

		let resolve_if = |env_var: &str| -> Option<PathBuf> {
			if !(input.xdg_platform && is_default) {
				return None;
			}
			let value = input.env.get(env_var)?;
			if value.is_empty() {
				return None;
			}
			let joined = Path::new(value).join(APP_NAME);
			joined.exists().then_some(joined)
		};
		let xdg_data = resolve_if("XDG_DATA_HOME");
		let xdg_state = resolve_if("XDG_STATE_HOME");
		let xdg_cache = resolve_if("XDG_CACHE_HOME");

		let pick = |xdg: &Option<PathBuf>, fallback: &Path| {
			xdg.clone().unwrap_or_else(|| fallback.to_path_buf())
		};
		let root_bases = [
			pick(&xdg_data, &config_root),
			pick(&xdg_state, &config_root),
			pick(&xdg_cache, &config_root),
		];
		// XDG flattens the agent/ prefix: ~/.gjc/agent/sessions → $XDG_DATA_HOME/gjc/sessions
		let agent_bases =
			[pick(&xdg_data, &agent_dir), pick(&xdg_state, &agent_dir), pick(&xdg_cache, &agent_dir)];

		Self { input, config_root, agent_dir, root_bases, agent_bases }
	}

	/// Config-directory name relative to home (`.gjc` or a trusted override).
	pub fn config_dir_name(&self) -> String {
		Self::config_dir_name_from(&self.input)
	}

	fn config_dir_name_from(input: &DirsInput) -> String {
		input
			.trusted_env("GJC_CONFIG_DIR")
			.and_then(sanitize_config_dir_name)
			.or_else(|| {
				input
					.trusted_env("PI_CONFIG_DIR")
					.and_then(sanitize_config_dir_name)
			})
			.unwrap_or(CONFIG_DIR_NAME)
			.to_owned()
	}

	fn agent_dir_override(input: &DirsInput) -> Option<&str> {
		input
			.trusted_env("GJC_CODING_AGENT_DIR")
			.or_else(|| input.trusted_env("PI_CODING_AGENT_DIR"))
	}

	fn base(dirs: &[PathBuf; 3], fallback: &Path, xdg: Option<Xdg>) -> PathBuf {
		match xdg {
			Some(Xdg::Data) => dirs[0].clone(),
			Some(Xdg::State) => dirs[1].clone(),
			Some(Xdg::Cache) => dirs[2].clone(),
			None => fallback.to_path_buf(),
		}
	}

	/// Config-root subdirectory, with optional XDG override.
	pub fn root_subdir(&self, subdir: impl AsRef<Path>, xdg: Option<Xdg>) -> PathBuf {
		Self::base(&self.root_bases, &self.config_root, xdg).join(subdir)
	}

	/// Agent subdirectory, with optional XDG override.
	pub fn agent_subdir(&self, subdir: impl AsRef<Path>, xdg: Option<Xdg>) -> PathBuf {
		Self::base(&self.agent_bases, &self.agent_dir, xdg).join(subdir)
	}

	// ── Common getters (same set as dirs.ts; extend as ports need them) ──

	pub fn sessions_dir(&self) -> PathBuf {
		self.agent_subdir("sessions", Some(Xdg::Data))
	}

	pub fn blobs_dir(&self) -> PathBuf {
		self.agent_subdir("blobs", Some(Xdg::Data))
	}

	pub fn agent_db_path(&self) -> PathBuf {
		self.agent_subdir("agent.db", Some(Xdg::Data))
	}

	pub fn history_db_path(&self) -> PathBuf {
		self.agent_subdir("history.db", Some(Xdg::Data))
	}

	pub fn logs_dir(&self) -> PathBuf {
		self.root_subdir("logs", Some(Xdg::State))
	}

	pub fn settings_path(&self) -> PathBuf {
		self.agent_dir.join("config.yml")
	}

	/// Project-local config directory (`<cwd>/.gjc`). Uses the default name,
	/// mirroring `getProjectAgentDir` (which ignores env overrides).
	pub fn project_agent_dir(&self) -> PathBuf {
		self.input.cwd.join(CONFIG_DIR_NAME)
	}
}

/// Node `path.resolve(cwd, p)` for an already-captured cwd.
fn absolutize(cwd: &Path, p: &Path) -> PathBuf {
	if p.is_absolute() {
		p.to_path_buf()
	} else {
		cwd.join(p)
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn input(env: &[(&str, &str)]) -> DirsInput {
		DirsInput {
			home: PathBuf::from("/home/u"),
			cwd: PathBuf::from("/proj"),
			env: env
				.iter()
				.map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
				.collect(),
			xdg_platform: true,
		}
	}

	#[test]
	fn default_layout() {
		let d = Dirs::resolve(input(&[]));
		assert_eq!(d.config_root, PathBuf::from("/home/u/.gjc"));
		assert_eq!(d.agent_dir, PathBuf::from("/home/u/.gjc/agent"));
		assert_eq!(d.sessions_dir(), PathBuf::from("/home/u/.gjc/agent/sessions"));
		assert_eq!(d.settings_path(), PathBuf::from("/home/u/.gjc/agent/config.yml"));
		assert_eq!(d.project_agent_dir(), PathBuf::from("/proj/.gjc"));
	}

	#[test]
	fn config_dir_override_and_sanitize() {
		let d = Dirs::resolve(input(&[("GJC_CONFIG_DIR", ".custom")]));
		assert_eq!(d.config_root, PathBuf::from("/home/u/.custom"));

		// `..` segments fall back to the default
		let d = Dirs::resolve(input(&[("GJC_CONFIG_DIR", "../escape")]));
		assert_eq!(d.config_root, PathBuf::from("/home/u/.gjc"));

		// absolute-looking names are joined beneath home
		let d = Dirs::resolve(input(&[("PI_CONFIG_DIR", "/abs/dir")]));
		assert_eq!(d.config_root, PathBuf::from("/home/u/abs/dir"));
	}

	#[test]
	fn agent_dir_override_disables_xdg() {
		let tmp = tempfile::tempdir().unwrap();
		let xdg = tmp.path().join("data");
		std::fs::create_dir_all(xdg.join("gjc")).unwrap();

		let mut i = input(&[("GJC_CODING_AGENT_DIR", "/custom/agent")]);
		i.env
			.insert("XDG_DATA_HOME".into(), xdg.to_string_lossy().into_owned());
		let d = Dirs::resolve(i);
		assert_eq!(d.agent_dir, PathBuf::from("/custom/agent"));
		// non-default agent dir → XDG ignored
		assert_eq!(d.sessions_dir(), PathBuf::from("/custom/agent/sessions"));
	}

	#[test]
	fn xdg_redirects_when_dir_exists() {
		let tmp = tempfile::tempdir().unwrap();
		let xdg = tmp.path().join("data");
		std::fs::create_dir_all(xdg.join("gjc")).unwrap();

		let mut i = input(&[]);
		i.env
			.insert("XDG_DATA_HOME".into(), xdg.to_string_lossy().into_owned());
		let d = Dirs::resolve(i);
		assert_eq!(d.sessions_dir(), xdg.join("gjc").join("sessions"));
		// state category not set → legacy path
		assert_eq!(d.logs_dir(), PathBuf::from("/home/u/.gjc/logs"));
	}

	#[test]
	fn xdg_ignored_when_target_missing() {
		let mut i = input(&[]);
		i.env
			.insert("XDG_DATA_HOME".into(), "/nonexistent-xdg".into());
		let d = Dirs::resolve(i);
		assert_eq!(d.sessions_dir(), PathBuf::from("/home/u/.gjc/agent/sessions"));
	}
}
