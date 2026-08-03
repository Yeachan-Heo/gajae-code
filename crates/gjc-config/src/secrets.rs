//! Secret-setting redaction rules.
//!
//! Port of the redaction helpers in
//! `packages/coding-agent/src/cli/config-cli.ts` (`isSecretSettingSegment`,
//! `isSecretSettingPath`, `redactConfigValue`).

use serde_json::Value;

pub const REDACTED_SECRET_VALUE: &str = "<redacted>";

const SECRET_SETTING_WORDS: [&str; 7] =
	["token", "secret", "password", "passwd", "pwd", "credential", "credentials"];
const SECRET_SETTING_COMPOUND_PREFIXES: [&str; 10] =
	["api", "auth", "access", "refresh", "bearer", "session", "client", "broker", "bot", "basic"];
const SECRET_SETTING_COMPOUND_SUFFIXES: [&str; 4] = ["token", "secret", "password", "credential"];

fn is_api_key_like(segment: &str) -> bool {
	// TS: /api[-_]?key/i
	let lower = segment.to_lowercase();
	lower.contains("apikey") || lower.contains("api-key") || lower.contains("api_key")
}

fn is_secret_setting_segment(segment: &str) -> bool {
	let normalized = segment.to_lowercase();
	if SECRET_SETTING_WORDS.contains(&normalized.as_str()) {
		return true;
	}
	if is_api_key_like(segment) {
		return true;
	}
	if normalized
		.split(['-', '_'])
		.filter(|w| !w.is_empty())
		.any(|w| SECRET_SETTING_WORDS.contains(&w))
	{
		return true;
	}
	SECRET_SETTING_COMPOUND_PREFIXES.iter().any(|prefix| {
		SECRET_SETTING_COMPOUND_SUFFIXES
			.iter()
			.any(|suffix| normalized == format!("{prefix}{suffix}"))
	})
}

pub fn is_secret_setting_path(path: &str) -> bool {
	path.split('.').any(is_secret_setting_segment)
}

/// `None` mirrors TS `undefined`. Undefined/null values pass through
/// unredacted, matching `redactConfigValue`.
pub fn redact_config_value(path: &str, value: Option<Value>, show_secrets: bool) -> Option<Value> {
	match value {
		Some(v) if !show_secrets && !v.is_null() && is_secret_setting_path(path) => {
			Some(Value::String(REDACTED_SECRET_VALUE.to_owned()))
		},
		other => other,
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use serde_json::json;

	#[test]
	fn secret_paths() {
		assert!(is_secret_setting_path("auth.broker.token"));
		assert!(is_secret_setting_path("notifications.telegram.botToken"));
		assert!(is_secret_setting_path("some.apiKey"));
		assert!(is_secret_setting_path("some.api_key"));
		assert!(is_secret_setting_path("my-token.value"));
		assert!(!is_secret_setting_path("theme.dark"));
		assert!(!is_secret_setting_path("session.directoryMigration"));
	}

	#[test]
	fn redaction() {
		assert_eq!(
			redact_config_value("auth.broker.token", Some(json!("abc")), false),
			Some(json!("<redacted>"))
		);
		assert_eq!(
			redact_config_value("auth.broker.token", Some(json!("abc")), true),
			Some(json!("abc"))
		);
		assert_eq!(redact_config_value("auth.broker.token", None, false), None);
		assert_eq!(
			redact_config_value("auth.broker.token", Some(Value::Null), false),
			Some(Value::Null)
		);
		assert_eq!(
			redact_config_value("theme.dark", Some(json!("red-claw")), false),
			Some(json!("red-claw"))
		);
	}
}
