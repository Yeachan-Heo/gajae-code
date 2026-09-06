//! Configuration for the shell output minimizer.
//!
//! [`MinimizerOptions`] is the N-API surface exposed through `ShellOptions`
//! and `ShellExecuteOptions`. [`MinimizerConfig`] is the internal resolved
//! view after merging field-level values with an optional TOML settings
//! file.

use std::{
	collections::{HashMap, HashSet},
	fs,
	path::{Path, PathBuf},
	sync::Arc,
};

use serde::Deserialize;

use crate::minimizer::pipeline::{self, PipelineRegistry, SUPPORTED_SCHEMA_VERSION};

const DEFAULT_MAX_CAPTURE_BYTES: u32 = 4 * 1024 * 1024;

fn normalize_max_capture_bytes(value: u32) -> u32 {
	value.clamp(1024, DEFAULT_MAX_CAPTURE_BYTES)
}

/// N-API opt-in handle for the minimizer.
#[derive(Debug, Clone, Default)]
pub struct MinimizerOptions {
	/// Master switch. Absent / false = disabled.
	pub enabled:           Option<bool>,
	/// Optional path to a TOML settings file whose values override
	/// field-level defaults. `~` is expanded.
	pub settings_path:     Option<String>,
	/// Optional xxHash64 digest (hex) of the settings file contents. When
	/// supplied, the engine refuses to honor a settings file whose hash does
	/// not match — a lightweight trust gate for agent-controllable paths.
	pub settings_hash:     Option<String>,
	/// Opt-in allowlist of program names (e.g. `"git"`). When empty or
	/// absent, all built-in filters are active.
	pub only:              Option<Vec<String>>,
	/// Program names explicitly excluded from minimization.
	pub except:            Option<Vec<String>>,
	/// Maximum captured bytes per command before the engine falls back to
	/// the raw, un-minimized output. Default 4 MiB.
	pub max_capture_bytes: Option<u32>,
}

/// Resolved minimizer configuration used by the engine.
#[derive(Debug, Clone)]
pub struct MinimizerConfig {
	pub enabled:           bool,
	pub only:              HashSet<String>,
	pub except:            HashSet<String>,
	pub max_capture_bytes: u32,
	pub per_command:       HashMap<String, toml::Value>,
	/// Compiled user-defined pipelines parsed from `settings_path`. Searched
	/// before the built-in pipelines so user filters win.
	pub user_pipelines:    Option<Arc<PipelineRegistry>>,
}

impl Default for MinimizerConfig {
	fn default() -> Self {
		Self {
			enabled:           false,
			only:              HashSet::new(),
			except:            HashSet::new(),
			max_capture_bytes: DEFAULT_MAX_CAPTURE_BYTES,
			per_command:       HashMap::new(),
			user_pipelines:    None,
		}
	}
}

impl MinimizerConfig {
	/// Build a resolved configuration from `MinimizerOptions`, optionally
	/// merging in a TOML settings file.
	pub fn from_options(opts: &MinimizerOptions) -> Self {
		let mut cfg = Self::default();
		if let Some(enabled) = opts.enabled {
			cfg.enabled = enabled;
		}
		if let Some(list) = opts.only.as_ref() {
			cfg.only = list.iter().map(|s| s.to_lowercase()).collect();
		}
		if let Some(list) = opts.except.as_ref() {
			cfg.except = list.iter().map(|s| s.to_lowercase()).collect();
		}
		if let Some(n) = opts.max_capture_bytes {
			cfg.max_capture_bytes = normalize_max_capture_bytes(n);
		}
		if let Some(path) = opts.settings_path.as_deref()
			&& !path.is_empty()
		{
			let expanded = expand_tilde(path);
			if let Ok(contents) = fs::read_to_string(&expanded) {
				if let Some(expected) = opts.settings_hash.as_deref()
					&& !expected.is_empty()
				{
					let actual = xxhash_rust::xxh64::xxh64(contents.as_bytes(), 0);
					let actual_hex = format!("{actual:016x}");
					if !actual_hex.eq_ignore_ascii_case(expected) {
						eprintln!(
							"[pi-natives minimizer] settings_hash mismatch for {} (expected {}, got {}); \
							 ignoring file",
							expanded.display(),
							expected,
							actual_hex
						);
						return cfg;
					}
				}
				if let Ok(file) = toml::from_str::<SettingsFile>(&contents) {
					file.merge_into(&mut cfg);
				}
				match pipeline::parse_file(&contents, "user") {
					Ok((pipelines, tests)) => {
						if !pipelines.is_empty() {
							cfg.user_pipelines = Some(Arc::new(PipelineRegistry { pipelines, tests }));
						}
					},
					Err(err) => {
						eprintln!("[pi-natives minimizer] user filters: {err}");
					},
				}
			}
		}
		cfg
	}

	/// Whether the engine should attempt to minimize output for `program`.
	pub fn is_program_enabled(&self, program: &str) -> bool {
		if !self.enabled {
			return false;
		}
		let key = program.to_lowercase();
		if self.except.contains(&key) {
			return false;
		}
		if !self.only.is_empty() && !self.only.contains(&key) {
			return false;
		}
		true
	}

	/// Fetch a per-command TOML table, if any.
	pub fn per_command(&self, program: &str) -> Option<&toml::Value> {
		self.per_command.get(&program.to_lowercase())
	}
}

#[derive(Debug, Default, Deserialize)]
struct SettingsFile {
	#[serde(default)]
	schema_version:    Option<u32>,
	enabled:           Option<bool>,
	only:              Option<Vec<String>>,
	except:            Option<Vec<String>>,
	max_capture_bytes: Option<u32>,
	#[serde(flatten)]
	tables:            HashMap<String, toml::Value>,
}

impl SettingsFile {
	fn merge_into(self, cfg: &mut MinimizerConfig) {
		if let Some(v) = self.schema_version
			&& v != SUPPORTED_SCHEMA_VERSION
		{
			eprintln!(
				"[pi-natives minimizer] unsupported schema_version {v} in settings file (expected \
				 {SUPPORTED_SCHEMA_VERSION})"
			);
			return;
		}
		if let Some(v) = self.enabled {
			cfg.enabled = v;
		}
		if let Some(list) = self.only {
			cfg.only = list.into_iter().map(|s| s.to_lowercase()).collect();
		}
		if let Some(list) = self.except {
			cfg.except = list.into_iter().map(|s| s.to_lowercase()).collect();
		}
		if let Some(n) = self.max_capture_bytes {
			cfg.max_capture_bytes = normalize_max_capture_bytes(n);
		}
		for (k, v) in self.tables {
			if v.is_table() && k != "filters" && k != "tests" {
				cfg.per_command.insert(k.to_lowercase(), v);
			}
		}
	}
}

fn expand_tilde(path: &str) -> PathBuf {
	if let Some(rest) = path.strip_prefix("~/")
		&& let Some(home) = home_dir()
	{
		return home.join(rest);
	}
	if path == "~"
		&& let Some(home) = home_dir()
	{
		return home;
	}
	Path::new(path).to_path_buf()
}

fn home_dir() -> Option<PathBuf> {
	#[cfg(unix)]
	{
		std::env::var_os("HOME").map(PathBuf::from)
	}
	#[cfg(windows)]
	{
		std::env::var_os("USERPROFILE")
			.or_else(|| std::env::var_os("HOMEPATH"))
			.map(PathBuf::from)
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn defaults_are_disabled() {
		let cfg = MinimizerConfig::default();
		assert!(!cfg.enabled);
		assert!(!cfg.is_program_enabled("git"));
	}

	#[test]
	fn enabled_without_only_enables_any_program() {
		let cfg = MinimizerConfig::from_options(&MinimizerOptions {
			enabled: Some(true),
			..Default::default()
		});
		assert!(cfg.is_program_enabled("git"));
		assert!(cfg.is_program_enabled("cargo"));
	}

	#[test]
	fn only_list_is_respected() {
		let cfg = MinimizerConfig::from_options(&MinimizerOptions {
			enabled: Some(true),
			only: Some(vec!["git".into()]),
			..Default::default()
		});
		assert!(cfg.is_program_enabled("git"));
		assert!(!cfg.is_program_enabled("cargo"));
	}

	#[test]
	fn except_overrides_only() {
		let cfg = MinimizerConfig::from_options(&MinimizerOptions {
			enabled: Some(true),
			except: Some(vec!["docker".into()]),
			..Default::default()
		});
		assert!(!cfg.is_program_enabled("docker"));
		assert!(cfg.is_program_enabled("git"));
	}

	#[test]
	fn missing_settings_path_is_not_fatal() {
		let cfg = MinimizerConfig::from_options(&MinimizerOptions {
			enabled: Some(true),
			settings_path: Some("/does/not/exist.toml".into()),
			..Default::default()
		});
		assert!(cfg.enabled);
	}

	#[test]
	fn capture_bytes_are_bounded_for_protocol_framing() {
		let high = MinimizerConfig::from_options(&MinimizerOptions {
			max_capture_bytes: Some(u32::MAX),
			..Default::default()
		});
		assert_eq!(high.max_capture_bytes, DEFAULT_MAX_CAPTURE_BYTES);

		let low = MinimizerConfig::from_options(&MinimizerOptions {
			max_capture_bytes: Some(0),
			..Default::default()
		});
		assert_eq!(low.max_capture_bytes, 1024);
	}
}
