//! Environment-file parsing primitives.
//!
//! Port of `packages/utils/src/env-file.ts` + the relevant checks from
//! `packages/utils/src/spawn-env.ts`. Parsing is intentionally identical:
//! dotenv keys must be POSIX shell identifiers, values must not contain NUL,
//! and shell startup files are parsed without executing user shell code.

use std::collections::HashMap;
use std::path::Path;

/// Strict shell-identifier shape: `[A-Za-z_][A-Za-z0-9_]*`.
pub fn is_valid_env_name(name: &str) -> bool {
	let mut chars = name.chars();
	match chars.next() {
		Some(c) if c.is_ascii_alphabetic() || c == '_' => {},
		_ => return false,
	}
	chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Values must not contain NUL (mirrors `isSafeEnvValue`).
pub fn is_safe_env_value(value: &str) -> bool {
	!value.contains('\0')
}

/// Strip an unquoted ` #comment` suffix, honoring `\` escapes and quotes.
fn strip_inline_shell_comment(value: &str) -> &str {
	let bytes: Vec<char> = value.chars().collect();
	let mut quote: Option<char> = None;
	let mut i = 0;
	let mut byte_pos = 0;
	while i < bytes.len() {
		let c = bytes[i];
		if c == '\\' {
			byte_pos += c.len_utf8() + bytes.get(i + 1).map_or(0, |n| n.len_utf8());
			i += 2;
			continue;
		}
		if (c == '"' || c == '\'') && (quote.is_none() || quote == Some(c)) {
			quote = if quote.is_some() { None } else { Some(c) };
			byte_pos += c.len_utf8();
			i += 1;
			continue;
		}
		if c == '#' && quote.is_none() && (i == 0 || bytes[i - 1].is_whitespace()) {
			return value[..byte_pos].trim_end();
		}
		byte_pos += c.len_utf8();
		i += 1;
	}
	value.trim_end()
}

fn unquote(value: &str) -> &str {
	if value.len() >= 2
		&& ((value.starts_with('"') && value.ends_with('"'))
			|| (value.starts_with('\'') && value.ends_with('\'')))
	{
		&value[1..value.len() - 1]
	} else {
		value
	}
}

/// Parse a `.env` file. Missing/unreadable files yield an empty map,
/// mirroring `parseEnvFile`.
pub fn parse_env_file(path: &Path) -> HashMap<String, String> {
	let mut result = HashMap::new();
	let Ok(content) = std::fs::read_to_string(path) else {
		return result;
	};
	for line in content.split('\n') {
		let trimmed = line.trim();
		if trimmed.is_empty() || trimmed.starts_with('#') {
			continue;
		}
		let Some(eq) = trimmed.find('=') else {
			continue;
		};
		let key = trimmed[..eq].trim();
		if !is_valid_env_name(key) {
			continue;
		}
		let value = unquote(trimmed[eq + 1..].trim());
		if !is_safe_env_value(value) {
			continue;
		}
		result.insert(key.to_owned(), value.to_owned());
	}
	result
}

/// Parse simple POSIX shell assignments without executing shell code.
///
/// Handles `export KEY=value` / `KEY=value` in startup files like `~/.zshrc`.
/// Mirrors `parseShellEnvFile`: dynamic values containing `$` or backticks
/// are ignored.
pub fn parse_shell_env_file(path: &Path) -> HashMap<String, String> {
	let mut result = HashMap::new();
	let Ok(content) = std::fs::read_to_string(path) else {
		return result;
	};
	for line in content.split('\n') {
		let trimmed = line.trim();
		if trimmed.is_empty() || trimmed.starts_with('#') {
			continue;
		}
		let rest = trimmed
			.strip_prefix("export ")
			.map_or(trimmed, str::trim_start);
		let Some(eq) = rest.find('=') else { continue };
		let key = rest[..eq].trim_end();
		if !is_valid_env_name(key) {
			continue;
		}
		let mut value = strip_inline_shell_comment(&rest[eq + 1..])
			.trim()
			.to_owned();
		if let Some(stripped) = value.strip_suffix(';') {
			value = stripped.trim_end().to_owned();
		}
		let value = unquote(&value);
		if !is_safe_env_value(value) || value.contains('$') || value.contains('`') {
			continue;
		}
		result.insert(key.to_owned(), value.to_owned());
	}
	result
}

#[cfg(test)]
mod tests {
	use super::*;
	use std::io::Write;

	fn write_temp(content: &str) -> tempfile::NamedTempFile {
		let mut f = tempfile::NamedTempFile::new().unwrap();
		f.write_all(content.as_bytes()).unwrap();
		f
	}

	#[test]
	fn env_file_basic() {
		let f = write_temp("FOO=bar\n# comment\nBAZ='quoted'\nQUX=\"dq\"\nBAD KEY=x\n1BAD=y\n");
		let map = parse_env_file(f.path());
		assert_eq!(map.get("FOO").unwrap(), "bar");
		assert_eq!(map.get("BAZ").unwrap(), "quoted");
		assert_eq!(map.get("QUX").unwrap(), "dq");
		assert!(!map.contains_key("BAD KEY"));
		assert!(!map.contains_key("1BAD"));
	}

	#[test]
	fn env_file_missing_returns_empty() {
		assert!(parse_env_file(Path::new("/nonexistent/.env")).is_empty());
	}

	#[test]
	fn shell_env_file_rules() {
		let f = write_temp(concat!(
			"export A=1\n",
			"B=two # trailing comment\n",
			"C=\"has # inside\"\n",
			"D=$HOME/dynamic\n",
			"E=`cmd`\n",
			"F='literal';\n",
		));
		let map = parse_shell_env_file(f.path());
		assert_eq!(map.get("A").unwrap(), "1");
		assert_eq!(map.get("B").unwrap(), "two");
		assert_eq!(map.get("C").unwrap(), "has # inside");
		assert!(!map.contains_key("D"));
		assert!(!map.contains_key("E"));
		assert_eq!(map.get("F").unwrap(), "literal");
	}
}
