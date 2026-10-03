//! Endpoint discovery file: how a client finds a session's WS server.
//!
//! Each running server writes `<state_root>/sdk/<sessionId>.json`
//! (under `.gjc/state/`, an already git-ignored runtime path) describing the
//! bound host/port and the per-session token. Clients read this file to
//! connect.
//!
//! Security/lifecycle guarantees:
//! - The directory is created `0700` and the file written `0600` (unix).
//! - Writes are atomic (temp file in the same dir, fsync, rename).
//! - The real token lives in the file (clients need it);
//!   [`EndpointRecord::redacted`] is the form that should appear in logs —
//!   never log the raw token.
//! - Stale files (explicitly marked, dead PID, or past TTL) are cleaned up.

use std::{
	fs,
	io::Write,
	path::{Path, PathBuf},
	time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};

/// On-disk endpoint descriptor.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EndpointRecord {
	/// Schema version.
	pub version:              u32,
	/// The session id this endpoint serves.
	pub session_id:           String,
	/// The OS process id hosting the server (for dead-PID stale cleanup).
	pub pid:                  u32,
	/// Bind host (always loopback in practice).
	pub host:                 String,
	/// Bound port.
	pub port:                 u16,
	/// Full `ws://host:port` URL.
	pub url:                  String,
	/// The per-session token. Required by clients; never log it raw.
	pub token:                String,
	/// Epoch-millis when the server started.
	pub started_at:           u64,
	/// Epoch-millis of the last update.
	pub updated_at:           u64,
	/// Set true when the server stopped but the file could not be removed.
	#[serde(default)]
	pub stale:                bool,
	/// Epoch-millis when the server stopped, if known.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub stopped_at:           Option<u64>,
	/// Lifecycle marker associated with the session's core-owned startup
	/// request.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub lifecycle_request_id: Option<String>,
	/// Startup-prompt reference associated with the session's startup request.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub startup_prompt_ref:   Option<String>,
}

impl EndpointRecord {
	/// Build a fresh record for a just-bound server.
	#[must_use]
	pub fn new(
		session_id: impl Into<String>,
		host: &str,
		port: u16,
		token: impl Into<String>,
	) -> Self {
		let now = now_millis();
		let host = host.to_owned();
		let url_host = if host.contains(':') && !host.starts_with('[') {
			format!("[{host}]")
		} else {
			host.clone()
		};
		Self {
			version: 1,
			session_id: session_id.into(),
			pid: std::process::id(),
			url: format!("ws://{url_host}:{port}"),
			host,
			port,
			token: token.into(),
			started_at: now,
			updated_at: now,
			stale: false,
			stopped_at: None,
			lifecycle_request_id: None,
			startup_prompt_ref: None,
		}
	}

	/// A log-safe clone with the token masked. Use this anywhere a record is
	/// logged.
	#[must_use]
	pub fn redacted(&self) -> Self {
		Self { token: redact_token(&self.token), ..self.clone() }
	}
}

/// Mask a token for logging: keep a short prefix only when the token is long
/// enough that the prefix is not the whole secret; otherwise reveal nothing but
/// the length. Never returns the full token.
#[must_use]
pub fn redact_token(token: &str) -> String {
	let len = token.chars().count();
	// Only show a prefix when it cannot reconstruct (most of) a short token.
	if len > 8 {
		let visible = token.chars().take(4).collect::<String>();
		format!("{visible}\u{2026}({len} chars)")
	} else {
		format!("\u{2026}({len} chars)")
	}
}

/// Directory holding per-session endpoint files under a GJC state root.
#[must_use]
pub fn endpoint_dir(state_root: &Path) -> PathBuf {
	state_root.join("sdk")
}

/// Path of the endpoint file for a given session.
#[must_use]
pub fn endpoint_path(state_root: &Path, session_id: &str) -> PathBuf {
	endpoint_dir(state_root).join(format!("{session_id}.json"))
}

/// Atomically write the endpoint file for a session.
///
/// Creates the directory (`0700` on unix), writes a temp file (`0600` on unix),
/// fsyncs, and renames into place.
///
/// # Errors
/// Propagates filesystem errors (permissions, disk, etc.).
pub fn write_endpoint(state_root: &Path, record: &EndpointRecord) -> std::io::Result<PathBuf> {
	let dir = endpoint_dir(state_root);
	#[cfg(unix)]
	{
		use std::os::unix::fs::DirBuilderExt;
		fs::DirBuilder::new()
			.recursive(true)
			.mode(0o700)
			.create(&dir)?;
	}
	#[cfg(not(unix))]
	fs::create_dir_all(&dir)?;
	harden_dir(&dir)?;

	let final_path = endpoint_path(state_root, &record.session_id);
	let tmp_path = dir.join(format!(".{}.{}.tmp", record.session_id, std::process::id()));

	let json = serde_json::to_vec_pretty(record).map_err(std::io::Error::other)?;
	{
		let mut file = create_private_file(&tmp_path)?;
		file.write_all(&json)?;
		file.sync_all()?;
	}
	fs::rename(&tmp_path, &final_path)?;
	harden_file(&final_path)?;
	Ok(final_path)
}

/// Read and parse an endpoint file, if present and valid.
#[must_use]
pub fn read_endpoint(path: &Path) -> Option<EndpointRecord> {
	let bytes = fs::read(path).ok()?;
	serde_json::from_slice(&bytes).ok()
}

/// Remove a session's endpoint file. If removal fails, mark it `stale` instead.
///
/// # Errors
/// Returns an error only if neither removal nor stale-marking succeeds.
pub fn remove_endpoint(state_root: &Path, session_id: &str) -> std::io::Result<()> {
	let path = endpoint_path(state_root, session_id);
	match fs::remove_file(&path) {
		Ok(()) => Ok(()),
		Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
		Err(_) => mark_stale(&path),
	}
}

/// Mark an endpoint file stale (token removed) when it cannot be deleted.
fn mark_stale(path: &Path) -> std::io::Result<()> {
	let Some(mut record) = read_endpoint(path) else {
		return fs::remove_file(path);
	};
	record.stale = true;
	record.stopped_at = Some(now_millis());
	record.token = String::new();
	let json = serde_json::to_vec_pretty(&record).map_err(std::io::Error::other)?;
	fs::write(path, json)
}

/// Remove stale endpoint files in the directory: those explicitly marked stale,
/// whose PID is dead, or older than `ttl_millis`. Returns how many were
/// removed.
///
/// # Errors
/// Propagates errors reading the directory; per-file removal errors are
/// ignored.
pub fn clean_stale(state_root: &Path, ttl_millis: u64) -> std::io::Result<usize> {
	let dir = endpoint_dir(state_root);
	let entries = match fs::read_dir(&dir) {
		Ok(entries) => entries,
		Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
		Err(e) => return Err(e),
	};
	let now = now_millis();
	let mut removed = 0usize;
	for entry in entries.flatten() {
		let path = entry.path();
		if path.extension().is_none_or(|ext| ext != "json") {
			continue;
		}
		let Some(record) = read_endpoint(&path) else {
			// Unparseable file in our directory: treat as stale junk.
			if fs::remove_file(&path).is_ok() {
				removed += 1;
			}
			continue;
		};
		let expired = now.saturating_sub(record.updated_at) > ttl_millis;
		if (record.stale || expired || !is_process_alive(record.pid))
			&& fs::remove_file(&path).is_ok()
		{
			removed += 1;
		}
	}
	Ok(removed)
}

fn now_millis() -> u64 {
	SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

/// Whether a process id is currently alive (best-effort; `true` on non-unix).
#[must_use]
pub fn is_process_alive(pid: u32) -> bool {
	#[cfg(unix)]
	{
		// signal 0 performs error checking without delivering a signal.
		// SAFETY: `libc::kill` with sig 0 only probes process existence; it has
		// no memory-safety preconditions and `pid` is a plain integer.
		let rc = unsafe { libc::kill(pid as libc::pid_t, 0) };
		if rc == 0 {
			return true;
		}
		// ESRCH => no such process; EPERM => exists but not signalable (alive).
		std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
	}
	#[cfg(not(unix))]
	{
		let _ = pid;
		true
	}
}

#[cfg(unix)]
fn create_private_file(path: &Path) -> std::io::Result<fs::File> {
	use std::os::unix::fs::OpenOptionsExt;
	fs::OpenOptions::new()
		.write(true)
		.create(true)
		.truncate(true)
		.mode(0o600)
		.open(path)
}

#[cfg(not(unix))]
fn create_private_file(path: &Path) -> std::io::Result<fs::File> {
	fs::OpenOptions::new()
		.write(true)
		.create(true)
		.truncate(true)
		.open(path)
}

#[cfg(unix)]
fn harden_dir(dir: &Path) -> std::io::Result<()> {
	use std::os::unix::fs::PermissionsExt;
	fs::set_permissions(dir, fs::Permissions::from_mode(0o700))
}

#[cfg(not(unix))]
fn harden_dir(_dir: &Path) -> std::io::Result<()> {
	Ok(())
}

#[cfg(unix)]
fn harden_file(path: &Path) -> std::io::Result<()> {
	use std::os::unix::fs::PermissionsExt;
	fs::set_permissions(path, fs::Permissions::from_mode(0o600))
}

#[cfg(not(unix))]
fn harden_file(_path: &Path) -> std::io::Result<()> {
	Ok(())
}

#[cfg(test)]
mod tests {
	use super::*;

	fn temp_root() -> PathBuf {
		use std::sync::atomic::{AtomicU64, Ordering};
		static COUNTER: AtomicU64 = AtomicU64::new(0);
		let unique = format!(
			"gjc-notif-disc-{}-{}-{}",
			std::process::id(),
			now_millis(),
			COUNTER.fetch_add(1, Ordering::Relaxed)
		);
		let root = std::env::temp_dir().join(unique);
		fs::create_dir_all(&root).unwrap();
		root
	}

	#[test]
	fn endpoint_with_lifecycle_markers_roundtrips() {
		let root = temp_root();
		let mut rec = EndpointRecord::new("sess-1", "127.0.0.1", 5555, "secret-token");
		rec.lifecycle_request_id = Some("lc_01".into());
		rec.startup_prompt_ref = Some("prompt_lc_01".into());
		let path = write_endpoint(&root, &rec).unwrap();
		let read = read_endpoint(&path).unwrap();
		assert_eq!(read.lifecycle_request_id.as_deref(), Some("lc_01"));
		assert_eq!(read.startup_prompt_ref.as_deref(), Some("prompt_lc_01"));
		assert_eq!(read, rec);
	}

	#[test]
	fn redact_token_never_reveals_full_or_short_tokens() {
		// Short tokens reveal only length, never any character of the secret.
		for short in ["Z", "ZZZZ", "ZZZZZZZZ"] {
			let red = redact_token(short);
			assert!(!red.contains(short), "leaked short token: {red}");
			assert!(red.contains("chars"));
		}
		// Long tokens may show a 4-char prefix but never the whole secret.
		let long = "abcdefghijklmnop";
		let red = redact_token(long);
		assert!(red.starts_with("abcd"));
		assert!(!red.contains(long));
	}

	#[test]
	fn endpoint_without_markers_omits_them_on_wire() {
		let rec = EndpointRecord::new("sess-1", "127.0.0.1", 5555, "secret-token");
		let json = serde_json::to_value(&rec).unwrap();
		assert!(json.get("lifecycleRequestId").is_none());
		assert!(json.get("startupPromptRef").is_none());
	}

	#[test]
	fn endpoint_ipv6_url_uses_bracketed_host() {
		let rec = EndpointRecord::new("sess-1", "::1", 5555, "secret-token");
		assert_eq!(rec.host, "::1");
		assert_eq!(rec.url, "ws://[::1]:5555");

		let already_bracketed = EndpointRecord::new("sess-2", "[::1]", 5555, "secret-token");
		assert_eq!(already_bracketed.url, "ws://[::1]:5555");
	}

	#[test]
	fn write_then_read_roundtrips_and_contains_token() {
		let root = temp_root();
		let rec = EndpointRecord::new("sess-1", "127.0.0.1", 5555, "secret-token");
		let path = write_endpoint(&root, &rec).unwrap();
		assert_eq!(path, endpoint_path(&root, "sess-1"));
		let read = read_endpoint(&path).unwrap();
		assert_eq!(read, rec);
		// file legitimately contains the real token (clients need it)
		let raw = fs::read_to_string(&path).unwrap();
		assert!(raw.contains("secret-token"));
		fs::remove_dir_all(&root).ok();
	}

	#[cfg(unix)]
	#[test]
	fn newly_created_endpoint_parents_are_private() {
		use std::os::unix::fs::PermissionsExt;
		let root = temp_root();
		let state_root = root.join(".gjc").join("state");
		let rec = EndpointRecord::new("sess-1", "127.0.0.1", 5555, "tok");
		write_endpoint(&state_root, &rec).unwrap();
		for dir in [root.join(".gjc"), state_root.clone(), endpoint_dir(&state_root)] {
			assert_eq!(fs::metadata(dir).unwrap().permissions().mode() & 0o777, 0o700);
		}
		fs::remove_dir_all(root).unwrap();
	}

	#[cfg(unix)]
	#[test]
	fn file_is_private_0600() {
		use std::os::unix::fs::PermissionsExt;
		let root = temp_root();
		let rec = EndpointRecord::new("sess-1", "127.0.0.1", 5555, "tok");
		let path = write_endpoint(&root, &rec).unwrap();
		let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
		assert_eq!(mode, 0o600, "endpoint file must be 0600, got {mode:o}");
		fs::remove_dir_all(&root).ok();
	}

	#[test]
	fn redaction_masks_token_but_keeps_length() {
		let rec = EndpointRecord::new("s", "127.0.0.1", 1, "supersecretvalue");
		let red = rec.redacted();
		assert_ne!(red.token, rec.token);
		assert!(!red.token.contains("supersecretvalue"));
		assert!(red.token.starts_with("supe"));
		assert!(red.token.contains("16 chars"));
	}

	#[test]
	fn remove_endpoint_deletes_file() {
		let root = temp_root();
		let rec = EndpointRecord::new("sess-1", "127.0.0.1", 5555, "tok");
		write_endpoint(&root, &rec).unwrap();
		remove_endpoint(&root, "sess-1").unwrap();
		assert!(read_endpoint(&endpoint_path(&root, "sess-1")).is_none());
		// removing a missing endpoint is a no-op success
		remove_endpoint(&root, "sess-1").unwrap();
		fs::remove_dir_all(&root).ok();
	}

	#[test]
	fn clean_stale_removes_marked_expired_and_deadpid_keeps_fresh() {
		let root = temp_root();

		// fresh, alive, current pid -> kept
		let fresh = EndpointRecord::new("fresh", "127.0.0.1", 1, "t");
		write_endpoint(&root, &fresh).unwrap();

		// explicitly stale -> removed
		let mut stale = EndpointRecord::new("stale", "127.0.0.1", 2, "t");
		stale.stale = true;
		write_endpoint(&root, &stale).unwrap();

		// expired by ttl -> removed
		let mut old = EndpointRecord::new("old", "127.0.0.1", 3, "t");
		old.updated_at = 1; // far in the past
		write_endpoint(&root, &old).unwrap();

		// dead pid -> removed (pid 1 is init; use an almost-certainly-dead high pid)
		let mut dead = EndpointRecord::new("dead", "127.0.0.1", 4, "t");
		dead.pid = 0x7fff_fffe;
		write_endpoint(&root, &dead).unwrap();

		let removed = clean_stale(&root, 60_000).unwrap();
		assert!(removed >= 2, "expected stale+expired removed, got {removed}");
		assert!(read_endpoint(&endpoint_path(&root, "fresh")).is_some(), "fresh kept");
		assert!(read_endpoint(&endpoint_path(&root, "stale")).is_none(), "stale removed");
		assert!(read_endpoint(&endpoint_path(&root, "old")).is_none(), "expired removed");
		fs::remove_dir_all(&root).ok();
	}

	#[test]
	fn clean_stale_on_missing_dir_is_zero() {
		let root = temp_root();
		let missing = root.join("does-not-exist");
		assert_eq!(clean_stale(&missing, 1000).unwrap(), 0);
		fs::remove_dir_all(&root).ok();
	}
}
