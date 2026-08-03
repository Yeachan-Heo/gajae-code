//! `gjc config` — read-only config CLI.
//!
//! Port of the read-side handlers in
//! `packages/coding-agent/src/cli/config-cli.ts` (`list`, `get`, `path`).
//! Output is uncolored, matching the Bun CLI when piped (chalk disables
//! color for non-TTY streams). Write-side actions (`set`, `reset`) and
//! `doctor`/`init-xdg` are not yet ported.

use std::collections::BTreeMap;

use anyhow::Result;
use clap::Subcommand;
use gjc_config::dirs::{Dirs, DirsInput};
use gjc_config::secrets::redact_config_value;
use gjc_config::settings::Settings;
use gjc_config::settings_schema::{SettingDef, SettingKind};
use serde_json::{Value, json};

#[derive(Subcommand)]
pub enum ConfigAction {
	/// List all settings with current values.
	List {
		#[arg(long)]
		json: bool,
		#[arg(long = "show-secrets")]
		show_secrets: bool,
	},
	/// Get a single setting value.
	Get {
		key: String,
		#[arg(long)]
		json: bool,
		#[arg(long = "show-secrets")]
		show_secrets: bool,
	},
	/// Print the agent config directory path.
	Path,
}

pub fn run(action: &ConfigAction) -> Result<()> {
	let dirs = Dirs::resolve(DirsInput::from_process()?);
	match action {
		ConfigAction::List { json, show_secrets } => {
			let settings = Settings::load(&dirs);
			if *json {
				list_json(&settings, *show_secrets);
			} else {
				list_plain(&settings, *show_secrets);
			}
		},
		ConfigAction::Get { key, json, show_secrets } => {
			let settings = Settings::load(&dirs);
			get_one(&settings, key, *json, *show_secrets)?;
		},
		ConfigAction::Path => println!("{}", dirs.agent_dir.display()),
	}
	Ok(())
}

fn description_of(def: &SettingDef) -> &str {
	def.description.as_deref().unwrap_or("")
}

fn list_json(settings: &Settings, show_secrets: bool) {
	let mut result = serde_json::Map::new();
	for path in settings.schema().paths() {
		let def = settings.schema().get(path).expect("path from schema");
		let value = redact_config_value(path, settings.get(path), show_secrets);
		let mut entry = serde_json::Map::new();
		// TS emits `value` first and JSON.stringify drops undefined values.
		if let Some(v) = value {
			entry.insert("value".into(), v);
		}
		entry.insert("type".into(), json!(def.kind.as_str()));
		entry.insert("description".into(), json!(description_of(def)));
		result.insert(path.to_owned(), Value::Object(entry));
	}
	println!("{}", serde_json::to_string_pretty(&Value::Object(result)).expect("valid json"));
}

fn list_plain(settings: &Settings, show_secrets: bool) {
	println!("Settings:\n");

	// Group by tab (settings without UI fall under "internal"), preserving
	// schema order within each group; groups sort lexicographically.
	let mut groups: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
	for path in settings.schema().paths() {
		let def = settings.schema().get(path).expect("path from schema");
		groups
			.entry(def.tab.as_deref().unwrap_or("internal"))
			.or_default()
			.push(path);
	}

	for (group, paths) in &groups {
		println!("[{group}]");
		for path in paths {
			let def = settings.schema().get(path).expect("path from schema");
			let value = redact_config_value(path, settings.get(path), show_secrets);
			println!("  {path} = {} {}", format_value(value.as_ref()), type_display(def));
		}
		println!();
	}
}

fn get_one(settings: &Settings, key: &str, as_json: bool, show_secrets: bool) -> Result<()> {
	let Some(def) = settings.schema().get(key) else {
		eprintln!("Unknown setting: {key}");
		eprintln!("\nRun 'gjc config list' to see available keys");
		std::process::exit(1);
	};

	let value = redact_config_value(key, settings.get(key), show_secrets);
	if as_json {
		let mut entry = serde_json::Map::new();
		entry.insert("key".into(), json!(key));
		if let Some(v) = value {
			entry.insert("value".into(), v);
		}
		entry.insert("type".into(), json!(def.kind.as_str()));
		entry.insert("description".into(), json!(description_of(def)));
		println!("{}", serde_json::to_string_pretty(&Value::Object(entry))?);
	} else {
		println!("{}", format_value(value.as_ref()));
	}
	Ok(())
}

/// Port of `formatValue`, uncolored.
fn format_value(value: Option<&Value>) -> String {
	match value {
		None | Some(Value::Null) => "(not set)".to_owned(),
		Some(Value::Bool(b)) => b.to_string(),
		Some(Value::Number(n)) => n.to_string(),
		Some(Value::String(s)) => s.clone(),
		Some(v) => serde_json::to_string(v).unwrap_or_else(|_| v.to_string()),
	}
}

/// Port of `getTypeDisplay`.
fn type_display(def: &SettingDef) -> String {
	if let Some(values) = def.values.as_deref()
		&& !values.is_empty()
	{
		return format!("({})", values.join("|"));
	}
	match def.kind {
		SettingKind::Boolean => "(boolean)".to_owned(),
		SettingKind::Number => "(number)".to_owned(),
		SettingKind::Array => "(array)".to_owned(),
		SettingKind::Record => "(record)".to_owned(),
		SettingKind::String | SettingKind::Enum => "(string)".to_owned(),
	}
}
