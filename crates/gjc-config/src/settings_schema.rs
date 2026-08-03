//! Flat settings-schema table.
//!
//! The table is generated from `packages/coding-agent/src/config/settings-schema.ts`
//! by `scripts/generate-json-schemas.ts` into `schemas/settings-flat.json` and
//! embedded here. Drift is caught by the generator's `--check` CI mode; never
//! hand-edit the JSON.

use std::collections::HashMap;
use std::sync::LazyLock;

use serde::Deserialize;
use serde_json::Value;

const SETTINGS_FLAT_JSON: &str = include_str!("../../../schemas/settings-flat.json");

/// Setting value type (mirrors the TS `SettingDef["type"]` union).
#[derive(Clone, Copy, PartialEq, Eq, Debug, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SettingKind {
	Boolean,
	String,
	Number,
	Enum,
	Array,
	Record,
}

impl SettingKind {
	/// Wire name used in CLI JSON output (matches the TS type string).
	pub const fn as_str(self) -> &'static str {
		match self {
			Self::Boolean => "boolean",
			Self::String => "string",
			Self::Number => "number",
			Self::Enum => "enum",
			Self::Array => "array",
			Self::Record => "record",
		}
	}
}

/// One setting definition (read-side subset of the TS `SettingDef`).
#[derive(Clone, Debug, Deserialize)]
pub struct SettingDef {
	#[serde(rename = "type")]
	pub kind: SettingKind,
	/// Default value; `None` mirrors a TS `undefined` default.
	#[serde(default)]
	pub default: Option<Value>,
	/// Enum values when `kind == Enum`.
	#[serde(default)]
	pub values: Option<Vec<String>>,
	/// UI description (`ui.description`); settings without UI have none, and
	/// the CLI renders those as an empty string like the Bun CLI does.
	#[serde(default)]
	pub description: Option<String>,
	/// UI tab (`ui.tab`); the CLI groups tab-less settings under `internal`.
	#[serde(default)]
	pub tab: Option<String>,
}

#[derive(Deserialize)]
struct FlatFile {
	settings: serde_json::Map<String, Value>,
}

/// The full settings schema in definition order.
pub struct SettingsSchema {
	order: Vec<String>,
	defs: HashMap<String, SettingDef>,
}

impl SettingsSchema {
	/// All setting paths in schema definition order (TS `ALL_SETTING_PATHS`).
	pub fn paths(&self) -> impl Iterator<Item = &str> {
		self.order.iter().map(String::as_str)
	}

	pub fn get(&self, path: &str) -> Option<&SettingDef> {
		self.defs.get(path)
	}

	pub fn contains(&self, path: &str) -> bool {
		self.defs.contains_key(path)
	}

	pub const fn len(&self) -> usize {
		self.order.len()
	}

	pub const fn is_empty(&self) -> bool {
		self.order.is_empty()
	}
}

/// Parsed embedded schema (panics only on a corrupt embedded asset, which is
/// a build-time defect, not a runtime input).
pub fn schema() -> &'static SettingsSchema {
	static SCHEMA: LazyLock<SettingsSchema> = LazyLock::new(|| {
		let file: FlatFile =
			serde_json::from_str(SETTINGS_FLAT_JSON).expect("embedded settings-flat.json is valid");
		let mut order = Vec::with_capacity(file.settings.len());
		let mut defs = HashMap::with_capacity(file.settings.len());
		for (path, raw) in file.settings {
			let def: SettingDef = serde_json::from_value(raw)
				.unwrap_or_else(|e| panic!("invalid setting def for {path}: {e}"));
			order.push(path.clone());
			defs.insert(path, def);
		}
		SettingsSchema { order, defs }
	});
	&SCHEMA
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn schema_parses_and_is_ordered() {
		let s = schema();
		assert!(s.len() > 300, "expected the full settings table, got {}", s.len());
		// First path in settings-schema.ts definition order.
		assert_eq!(s.paths().next(), Some("lastChangelogVersion"));
	}

	#[test]
	fn known_defs() {
		let s = schema();
		let d = s.get("session.directoryMigration").unwrap();
		assert_eq!(d.kind, SettingKind::Enum);
		assert_eq!(d.default, Some(Value::String("copy-retain".into())));
		assert_eq!(d.values.as_deref().unwrap(), ["copy-retain", "disabled"]);

		let d = s.get("sdk.promptDeadlineMs").unwrap();
		assert_eq!(d.kind, SettingKind::Number);
		assert_eq!(d.default, Some(Value::from(1_800_000)));

		// undefined default → None
		let d = s.get("lastChangelogVersion").unwrap();
		assert_eq!(d.kind, SettingKind::String);
		assert!(d.default.is_none());
	}
}
