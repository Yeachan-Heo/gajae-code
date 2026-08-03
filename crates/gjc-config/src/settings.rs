//! Read-only settings resolution.
//!
//! Port of the read path of `packages/coding-agent/src/config/settings.ts` plus
//! the builtin settings-capability provider from
//! `packages/coding-agent/src/discovery/builtin.ts`:
//!
//! - global layer: YAML at `<agentDir>/config.yml`
//! - project layer: `<cwd>/.gjc/settings.json` then `<cwd>/.gjc/config.yml`
//!   (later files override earlier ones), with non-local `notifications.*`
//!   settings stripped (`#stripProjectNotificationSettings`)
//! - `merged = deepMerge(global, project)`; `get(path)` falls back to the
//!   schema default
//!
//! Deliberately not ported yet (documented deferrals, tracked in
//! `docs/roadmap/full-conversion-to-rust.md`):
//! - write path (atomic YAML patching, persistence, hooks)
//! - legacy raw-settings migrations (`#migrateRawSettings`); configs written by
//!   current Bun builds carry `configSchemaVersion: 1` and skip them too
//! - imported-agent settings providers (claude/gemini/cursor discovery)
//! - path-scoped string-array resolution (`resolvePathScopedStringArray`)

use std::path::Path;

use serde_json::{Map, Value};

use crate::{
	dirs::Dirs,
	settings_schema::{SettingsSchema, schema},
};

/// Project-safe notification keys (TS `LOCAL_NOTIFICATION_SETTING_KEYS`).
const LOCAL_NOTIFICATION_SETTING_KEYS: [&str; 4] =
	["terminalBell", "bellOnComplete", "bellOnApproval", "bellOnAsk"];

/// Port of `Settings.#deepMerge`: objects merge recursively, everything else
/// (including arrays) is replaced by the override.
pub fn deep_merge(base: &Map<String, Value>, overrides: &Map<String, Value>) -> Map<String, Value> {
	let mut result = base.clone();
	for (key, override_value) in overrides {
		match (base.get(key), override_value) {
			(Some(Value::Object(base_obj)), Value::Object(override_obj)) => {
				result.insert(key.clone(), Value::Object(deep_merge(base_obj, override_obj)));
			},
			_ => {
				result.insert(key.clone(), override_value.clone());
			},
		}
	}
	result
}

/// Port of `#stripProjectNotificationSettings`: project layers may only carry
/// the local terminal-bell notification keys.
fn strip_project_notification_settings(settings: &Map<String, Value>) -> Map<String, Value> {
	let mut sanitized = Map::new();
	for (key, value) in settings {
		if key == "notifications"
			&& let Value::Object(obj) = value
		{
			let local: Map<String, Value> = obj
				.iter()
				.filter(|(k, _)| LOCAL_NOTIFICATION_SETTING_KEYS.contains(&k.as_str()))
				.map(|(k, v)| (k.clone(), v.clone()))
				.collect();
			if !local.is_empty() {
				sanitized.insert(key.clone(), Value::Object(local));
			}
			continue;
		}
		if is_notification_settings_path(key) {
			continue;
		}
		sanitized.insert(key.clone(), value.clone());
	}
	sanitized
}

fn is_notification_settings_path(path: &str) -> bool {
	if path != "notifications" && !path.starts_with("notifications.") {
		return false;
	}
	!LOCAL_NOTIFICATION_SETTING_KEYS
		.iter()
		.any(|k| path == format!("notifications.{k}"))
}

fn parse_yaml_object(path: &Path) -> Map<String, Value> {
	let Ok(content) = std::fs::read_to_string(path) else {
		return Map::new();
	};
	match serde_yaml::from_str::<Value>(&content) {
		Ok(Value::Object(map)) => map,
		_ => Map::new(),
	}
}

fn parse_json_object(path: &Path) -> Map<String, Value> {
	let Ok(content) = std::fs::read_to_string(path) else {
		return Map::new();
	};
	match serde_json::from_str::<Value>(&content) {
		Ok(Value::Object(map)) => map,
		_ => Map::new(),
	}
}

/// Read-only merged settings view.
pub struct Settings {
	merged: Map<String, Value>,
	schema: &'static SettingsSchema,
}

impl Settings {
	/// Load and merge the global and project layers for the given dirs.
	pub fn load(dirs: &Dirs) -> Self {
		let global = parse_yaml_object(&dirs.settings_path());

		// Builtin settings provider: `<cwd>/.gjc/settings.json` then
		// `<cwd>/.gjc/config.yml`; later items override earlier ones.
		let project_dir = dirs.project_agent_dir();
		let mut project = Map::new();
		if project_dir.is_dir() {
			for candidate in [project_dir.join("settings.json"), project_dir.join("config.yml")] {
				let raw = if candidate.extension().is_some_and(|e| e == "json") {
					parse_json_object(&candidate)
				} else {
					parse_yaml_object(&candidate)
				};
				if raw.is_empty() {
					continue;
				}
				project = deep_merge(&project, &strip_project_notification_settings(&raw));
			}
		}

		let merged = deep_merge(&global, &project);
		Self { merged, schema: schema() }
	}

	/// Build from already-parsed layers (tests, parity harness).
	pub fn from_layers(global: Map<String, Value>, project: Map<String, Value>) -> Self {
		let merged = deep_merge(&global, &strip_project_notification_settings(&project));
		Self { merged, schema: schema() }
	}

	pub const fn schema(&self) -> &'static SettingsSchema {
		self.schema
	}

	/// Port of `Settings.get`: merged value at the dotted path, falling back
	/// to the schema default. `None` mirrors TS `undefined`.
	pub fn get(&self, path: &str) -> Option<Value> {
		if let Some(value) = get_by_path(&self.merged, path) {
			return Some(value.clone());
		}
		self.schema.get(path).and_then(|def| def.default.clone())
	}
}

fn get_by_path<'a>(map: &'a Map<String, Value>, path: &str) -> Option<&'a Value> {
	let mut segments = path.split('.');
	let mut current = map.get(segments.next()?)?;
	for segment in segments {
		current = current.as_object()?.get(segment)?;
	}
	Some(current)
}

#[cfg(test)]
mod tests {
	use serde_json::json;

	use super::*;

	fn obj(v: Value) -> Map<String, Value> {
		v.as_object().unwrap().clone()
	}

	#[test]
	fn deep_merge_objects_recursively_and_replaces_scalars_and_arrays() {
		let base = obj(json!({"a": {"x": 1, "y": 2}, "list": [1, 2], "keep": true}));
		let over = obj(json!({"a": {"y": 3}, "list": [9]}));
		let merged = deep_merge(&base, &over);
		assert_eq!(Value::Object(merged), json!({"a": {"x": 1, "y": 3}, "list": [9], "keep": true}));
	}

	#[test]
	fn get_prefers_project_over_global_over_default() {
		let global = obj(json!({"session": {"directoryMigration": "disabled"}}));
		let project = obj(json!({}));
		let s = Settings::from_layers(global, project);
		assert_eq!(s.get("session.directoryMigration"), Some(json!("disabled")));

		let s = Settings::from_layers(
			obj(json!({"session": {"directoryMigration": "disabled"}})),
			obj(json!({"session": {"directoryMigration": "copy-retain"}})),
		);
		assert_eq!(s.get("session.directoryMigration"), Some(json!("copy-retain")));

		// schema default fallback
		let s = Settings::from_layers(Map::new(), Map::new());
		assert_eq!(s.get("session.directoryMigration"), Some(json!("copy-retain")));
		// undefined default stays None
		assert_eq!(s.get("lastChangelogVersion"), None);
	}

	#[test]
	fn project_notification_settings_are_stripped_except_local_keys() {
		let project = obj(json!({
			 "notifications": {
				  "enabled": true,
				  "terminalBell": false,
				  "telegram": {"botToken": "x"}
			 },
			 "theme": {"dark": "red-claw"}
		}));
		let s = Settings::from_layers(Map::new(), project);
		// non-local project notification settings are rejected
		assert_eq!(s.get("notifications.enabled"), Some(json!(false))); // schema default
		assert_eq!(s.get("notifications.telegram.botToken"), None);
		// local bell key survives
		assert_eq!(s.get("notifications.terminalBell"), Some(json!(false)));
		assert_eq!(s.get("theme.dark"), Some(json!("red-claw")));
	}

	#[test]
	fn load_reads_yaml_and_json_layers() {
		let tmp = tempfile::tempdir().unwrap();
		let agent = tmp.path().join("home/.gjc/agent");
		std::fs::create_dir_all(&agent).unwrap();
		std::fs::write(
			agent.join("config.yml"),
			"theme:\n  dark: red-claw\nsdk:\n  promptDeadlineMs: 60000\n",
		)
		.unwrap();
		let proj = tmp.path().join("proj/.gjc");
		std::fs::create_dir_all(&proj).unwrap();
		std::fs::write(proj.join("settings.json"), r#"{"theme": {"dark": "blue-crab"}}"#).unwrap();

		let dirs = Dirs::resolve(crate::dirs::DirsInput {
			home:         tmp.path().join("home"),
			cwd:          tmp.path().join("proj"),
			env:          std::collections::HashMap::new(),
			xdg_platform: false,
		});
		let s = Settings::load(&dirs);
		assert_eq!(s.get("theme.dark"), Some(json!("blue-crab")));
		assert_eq!(s.get("sdk.promptDeadlineMs"), Some(json!(60000)));
	}
}
