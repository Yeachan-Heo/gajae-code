//! Managed session-scope layout.
//!
//! Port of the naming scheme in
//! `packages/coding-agent/src/session/internal/managed-session-scope.ts`:
//! each workspace cwd maps to `sessions/v2-<digest>` where the digest is a
//! lowercase base32 SHA-256 over a domain-separated identity string, and the
//! directory carries a JSON binding file naming its canonical cwd.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Binding file name (TS `MANAGED_SESSION_BINDING_FILE`).
pub const MANAGED_SESSION_BINDING_FILE: &str = ".gjc-managed-session-scope.v2.json";

/// Internal bookkeeping directory name (TS `MANAGED_INTERNAL_DIRECTORY`).
pub const MANAGED_INTERNAL_DIRECTORY: &str = ".gjc-managed-session-internal";

const BASE32: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";

/// Platform tag used in the scope identity (TS `"posix" | "win32"`).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ScopePlatform {
	Posix,
	Win32,
}

impl ScopePlatform {
	pub const fn current() -> Self {
		if cfg!(windows) {
			Self::Win32
		} else {
			Self::Posix
		}
	}

	const fn as_str(self) -> &'static str {
		match self {
			Self::Posix => "posix",
			Self::Win32 => "win32",
		}
	}
}

/// Port of `scopeDigest`: lowercase-base32 SHA-256 over the domain-separated
/// scope identity.
pub fn scope_digest(platform: ScopePlatform, canonical_path: &str) -> String {
	let mut hasher = Sha256::new();
	hasher.update(b"gjc-managed-session-scope\0identity-v1\0");
	hasher.update(platform.as_str().as_bytes());
	hasher.update(b"\0");
	hasher.update(canonical_path.as_bytes());
	let bytes = hasher.finalize();

	let mut result = String::with_capacity(bytes.len().div_ceil(5) * 8);
	let mut accumulator: u32 = 0;
	let mut bits: u32 = 0;
	for byte in bytes {
		accumulator = (accumulator << 8) | u32::from(byte);
		bits += 8;
		while bits >= 5 {
			result.push(BASE32[((accumulator >> (bits - 5)) & 31) as usize] as char);
			bits -= 5;
		}
	}
	if bits > 0 {
		result.push(BASE32[((accumulator << (5 - bits)) & 31) as usize] as char);
	}
	result
}

/// Scope directory name for a canonical cwd (`v2-<digest>`).
pub fn scope_directory_name(platform: ScopePlatform, canonical_cwd: &str) -> String {
	format!("v2-{}", scope_digest(platform, canonical_cwd))
}

/// Scope directory path beneath a sessions root.
pub fn scope_directory_path(sessions_root: &Path, canonical_cwd: &str) -> PathBuf {
	sessions_root.join(scope_directory_name(ScopePlatform::current(), canonical_cwd))
}

/// Parsed scope binding file (`.gjc-managed-session-scope.v2.json`).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopeBinding {
	pub schema_version:   u32,
	pub layout_version:   u32,
	pub identity_version: u32,
	pub platform:         String,
	pub canonical_path:   String,
	pub identity_digest:  String,
	/// Preserve fields future layouts may add.
	#[serde(flatten)]
	pub extra:            serde_json::Map<String, serde_json::Value>,
}

impl ScopeBinding {
	/// Read and parse the binding file inside a scope directory.
	pub fn read(scope_dir: &Path) -> anyhow::Result<Self> {
		let raw = std::fs::read_to_string(scope_dir.join(MANAGED_SESSION_BINDING_FILE))?;
		Ok(serde_json::from_str(&raw)?)
	}
}

/// List all `v2-*` scope directories beneath a sessions root, with their
/// bindings when readable. Order is unspecified (callers sort as needed).
pub fn list_scopes(sessions_root: &Path) -> Vec<(PathBuf, Option<ScopeBinding>)> {
	let Ok(entries) = std::fs::read_dir(sessions_root) else {
		return Vec::new();
	};
	entries
		.filter_map(Result::ok)
		.filter(|e| e.file_name().to_string_lossy().starts_with("v2-"))
		.filter(|e| e.path().is_dir())
		.map(|e| {
			let path = e.path();
			let binding = ScopeBinding::read(&path).ok();
			(path, binding)
		})
		.collect()
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn digest_matches_bun_reference() {
		// Reference values produced by the TS implementation:
		// computeManagedScopeDigest("posix", "/tmp/gjc-parity-check") and
		// computeManagedScopeDigest("win32", "C:\\gjc\\parity").
		assert_eq!(
			scope_digest(ScopePlatform::Posix, "/tmp/gjc-parity-check"),
			"koeefpfylk7nw7dsahoavseb3fz47pfb2627h6qcsty4dlyikvuq"
		);
		assert_eq!(
			scope_digest(ScopePlatform::Win32, "C:\\gjc\\parity"),
			"st3lb7larwwpmnhky2rmt4d5d3vdz6g62anb2uzlrbfkcpaktqoq"
		);
	}

	#[test]
	fn binding_round_trips_with_unknown_fields() {
		let raw = r#"{"schemaVersion":1,"layoutVersion":2,"identityVersion":1,"platform":"posix","canonicalPath":"/x","identityDigest":"abc","futureField":{"a":1}}"#;
		let parsed: ScopeBinding = serde_json::from_str(raw).unwrap();
		assert_eq!(parsed.canonical_path, "/x");
		assert_eq!(parsed.extra.get("futureField").unwrap()["a"], 1);
		let out = serde_json::to_value(&parsed).unwrap();
		assert_eq!(out["futureField"]["a"], 1);
	}
}
