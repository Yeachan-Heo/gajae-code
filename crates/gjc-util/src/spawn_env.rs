//! Spawn-environment filtering. Port of `packages/utils/src/spawn-env.ts`.

use std::collections::HashMap;

const MACOS_MALLOC_STACK_LOGGING_ENV: [&str; 2] =
	["MallocStackLogging", "MallocStackLoggingNoCompact"];

pub fn is_safe_env_name(name: &str) -> bool {
	!name.is_empty() && !name.contains('=') && !name.contains('\0')
}

pub fn is_safe_env_value(value: &str) -> bool {
	!value.contains('\0')
}

pub fn should_forward_spawn_env_name(name: &str) -> bool {
	is_safe_env_name(name) && !MACOS_MALLOC_STACK_LOGGING_ENV.contains(&name)
}

/// Drop unsafe names/values and the macOS malloc-logging variables.
#[allow(clippy::implicit_hasher, reason = "call sites all use the default hasher")]
pub fn filter_process_env(env: &HashMap<String, String>) -> HashMap<String, String> {
	env.iter()
		.filter(|(name, value)| should_forward_spawn_env_name(name) && is_safe_env_value(value))
		.map(|(name, value)| (name.clone(), value.clone()))
		.collect()
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn filters_unsafe_and_malloc_vars() {
		let env: HashMap<String, String> = [
			("PATH", "/usr/bin"),
			("MallocStackLogging", "1"),
			("MallocStackLoggingNoCompact", "1"),
			("OK_NAME", "with\0nul"),
		]
		.into_iter()
		.map(|(k, v)| (k.to_owned(), v.to_owned()))
		.collect();

		let filtered = filter_process_env(&env);
		assert_eq!(filtered.len(), 1);
		assert_eq!(filtered.get("PATH").unwrap(), "/usr/bin");
	}

	#[test]
	fn name_and_value_rules() {
		assert!(is_safe_env_name("FOO"));
		assert!(!is_safe_env_name(""));
		assert!(!is_safe_env_name("A=B"));
		assert!(!is_safe_env_name("A\0B"));
		assert!(is_safe_env_value("anything"));
		assert!(!is_safe_env_value("nul\0"));
	}
}
