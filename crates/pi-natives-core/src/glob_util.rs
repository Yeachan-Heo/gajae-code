//! Shared glob-pattern helpers.
//!
//! Used by the `pi-natives` glob/grep facades and the `gjc` host. Moved
//! from `pi-natives/src/glob_util.rs`; errors are plain strings here and
//! converted to NAPI errors in the facade.

use globset::{GlobBuilder, GlobSet, GlobSetBuilder};

/// Normalize a raw glob string: fix path separators, optionally prepend `**/`
/// for recursive matching, and close any unclosed `{` alternation groups.
pub fn build_glob_pattern(glob: &str, recursive: bool) -> String {
	let normalized = glob.replace('\\', "/");
	let pattern = if !recursive
		|| normalized.contains('/')
		|| normalized.starts_with("**")
		|| is_exact_brace_union(&normalized)
	{
		normalized
	} else {
		format!("**/{normalized}")
	};
	fix_unclosed_braces(pattern)
}

/// Compile a glob pattern string into a [`GlobSet`].
///
/// When `recursive` is true, simple patterns (no path separators, no leading
/// `**`) are automatically prefixed with `**/`.
pub fn compile_glob(glob: &str, recursive: bool) -> Result<GlobSet, String> {
	let mut builder = GlobSetBuilder::new();
	let pattern = build_glob_pattern(glob, recursive);
	let glob = GlobBuilder::new(&pattern)
		.literal_separator(true)
		.build()
		.map_err(|err| format!("Invalid glob pattern: {err}"))?;
	builder.add(glob);
	builder
		.build()
		.map_err(|err| format!("Failed to build glob matcher: {err}"))
}

/// Like [`compile_glob`], but accepts an `Option<&str>` — returns `Ok(None)`
/// when the input is `None`, empty, or whitespace-only.
pub fn try_compile_glob(glob: Option<&str>, recursive: bool) -> Result<Option<GlobSet>, String> {
	let Some(glob) = glob.map(str::trim).filter(|v| !v.is_empty()) else {
		return Ok(None);
	};
	compile_glob(glob, recursive).map(Some)
}

/// Close unclosed `{` alternation groups in a glob pattern.
///
/// LLMs occasionally produce patterns like `*.{ts,js` without the closing `}`.
/// Rather than failing, we append the missing braces.
fn fix_unclosed_braces(pattern: String) -> String {
	let opens = pattern.chars().filter(|&c| c == '{').count();
	let closes = pattern.chars().filter(|&c| c == '}').count();
	if opens > closes {
		let mut fixed = pattern;
		for _ in 0..(opens - closes) {
			fixed.push('}');
		}
		fixed
	} else {
		pattern
	}
}

fn is_exact_brace_union(pattern: &str) -> bool {
	if !(pattern.starts_with('{') && pattern.ends_with('}')) {
		return false;
	}
	let inner = &pattern[1..pattern.len() - 1];
	!inner.is_empty()
		&& !inner
			.chars()
			.any(|ch| matches!(ch, '*' | '?' | '[' | ']' | '{' | '}'))
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn simple_pattern_gets_recursive_prefix() {
		assert_eq!(build_glob_pattern("*.ts", true), "**/*.ts");
	}

	#[test]
	fn pattern_with_path_stays_as_is() {
		assert_eq!(build_glob_pattern("src/*.ts", true), "src/*.ts");
	}

	#[test]
	fn already_recursive_pattern_unchanged() {
		assert_eq!(build_glob_pattern("**/*.rs", true), "**/*.rs");
	}

	#[test]
	fn non_recursive_keeps_simple_pattern() {
		assert_eq!(build_glob_pattern("*.ts", false), "*.ts");
	}

	#[test]
	fn backslashes_normalized() {
		assert_eq!(build_glob_pattern("src\\**\\*.ts", true), "src/**/*.ts");
	}

	#[test]
	fn unclosed_brace_gets_closed() {
		assert_eq!(build_glob_pattern("*.{ts,tsx,js", true), "**/*.{ts,tsx,js}");
	}

	#[test]
	fn deeply_unclosed_braces_all_closed() {
		assert_eq!(build_glob_pattern("{a,{b,c}", true), "**/{a,{b,c}}");
	}

	#[test]
	fn balanced_braces_unchanged() {
		assert_eq!(build_glob_pattern("*.{ts,js}", true), "**/*.{ts,js}");
	}

	#[test]
	fn compile_glob_accepts_valid_pattern() {
		assert!(compile_glob("*.ts", true).is_ok());
	}

	#[test]
	fn compile_glob_fixes_unclosed_brace() {
		assert!(compile_glob("*.{ts,tsx,js", true).is_ok());
	}

	#[test]
	fn exact_brace_union_stays_non_recursive() {
		assert_eq!(build_glob_pattern("{alpha.txt,beta.txt}", true), "{alpha.txt,beta.txt}");
	}

	#[test]
	fn glob_brace_union_still_gets_recursive_prefix() {
		assert_eq!(build_glob_pattern("{*.ts,*.tsx}", true), "**/{*.ts,*.tsx}");
	}
}
