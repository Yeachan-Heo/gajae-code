//! Session transcript (JSONL) parsing.
//!
//! Port of the transcript read path in
//! `packages/coding-agent/src/session/session-manager.ts`: the first line is
//! a `{"type":"session",...}` header, each following line is one entry with
//! `type`/`id`/`parentId`/`timestamp` plus type-specific fields. Transcript
//! filenames are `<iso-timestamp with [:.] replaced by "-">_<sessionId>.jsonl`.
//!
//! Parsing is loss-free: every entry keeps its unknown fields in `extra`, and
//! re-serialization round-trips them (`serde(flatten)`).

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// Transcript header line (`type: "session"`).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionHeader {
	#[serde(rename = "type")]
	pub kind:         String,
	pub version:      u32,
	pub id:           String,
	pub timestamp:    String,
	pub cwd:          String,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub title:        Option<String>,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub title_source: Option<String>,
	#[serde(flatten)]
	pub extra:        Map<String, Value>,
}

/// One transcript entry after the header.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionEntry {
	#[serde(rename = "type")]
	pub kind:      String,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub id:        Option<String>,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub timestamp: Option<String>,
	#[serde(flatten)]
	pub extra:     Map<String, Value>,
}

impl SessionEntry {
	/// `parentId` stays in `extra` so an explicit JSON `null` (root entries)
	/// survives round-trips; serde's `Option` cannot distinguish null from
	/// absent. `Some(&Value::Null)` means an explicit null parent.
	pub fn parent_id(&self) -> Option<&Value> {
		self.extra.get("parentId")
	}
}

/// A parsed transcript: header plus entries.
#[derive(Clone, Debug)]
pub struct Transcript {
	pub header:  SessionHeader,
	pub entries: Vec<SessionEntry>,
}

impl Transcript {
	/// Parse a transcript from its JSONL text. Blank lines are skipped
	/// (interrupted writes can leave a trailing newline).
	pub fn parse(content: &str) -> Result<Self> {
		let mut lines = content.lines().filter(|l| !l.trim().is_empty());
		let header_line = lines.next().context("transcript is empty")?;
		let header: SessionHeader =
			serde_json::from_str(header_line).context("invalid transcript header")?;
		anyhow::ensure!(header.kind == "session", "first line is not a session header");

		let mut entries = Vec::new();
		for (index, line) in lines.enumerate() {
			let entry: SessionEntry = serde_json::from_str(line)
				.with_context(|| format!("invalid transcript entry at line {}", index + 2))?;
			entries.push(entry);
		}
		Ok(Self { header, entries })
	}

	/// Read and parse a transcript file.
	pub fn read(path: &Path) -> Result<Self> {
		let content = std::fs::read_to_string(path)
			.with_context(|| format!("cannot read transcript {}", path.display()))?;
		Self::parse(&content)
	}

	/// Serialize back to JSONL (header first, one entry per line, trailing
	/// newline) preserving unknown fields.
	pub fn to_jsonl(&self) -> Result<String> {
		let mut out = serde_json::to_string(&self.header)?;
		out.push('\n');
		for entry in &self.entries {
			out.push_str(&serde_json::to_string(entry)?);
			out.push('\n');
		}
		Ok(out)
	}
}

/// Summary of one transcript file found in a scope directory.
#[derive(Clone, Debug)]
pub struct TranscriptFile {
	pub path:           PathBuf,
	/// Session id parsed from the filename (`<timestamp>_<id>.jsonl`).
	pub session_id:     String,
	/// Filename timestamp segment (filesystem-safe encoding).
	pub file_timestamp: String,
}

/// Split a transcript filename into its timestamp and session-id parts.
fn split_transcript_name(name: &str) -> Option<(String, String)> {
	let stem = name.strip_suffix(".jsonl")?;
	let (timestamp, id) = stem.split_once('_')?;
	if timestamp.is_empty() || id.is_empty() {
		return None;
	}
	Some((timestamp.to_owned(), id.to_owned()))
}

/// List transcript files in a scope directory, newest first (filename
/// timestamps are ISO-derived, so lexicographic order is chronological).
pub fn list_transcripts(scope_dir: &Path) -> Vec<TranscriptFile> {
	let Ok(entries) = std::fs::read_dir(scope_dir) else {
		return Vec::new();
	};
	let mut files: Vec<TranscriptFile> = entries
		.filter_map(Result::ok)
		.filter_map(|e| {
			let name = e.file_name().to_string_lossy().into_owned();
			let (file_timestamp, session_id) = split_transcript_name(&name)?;
			e.path()
				.is_file()
				.then(|| TranscriptFile { path: e.path(), session_id, file_timestamp })
		})
		.collect();
	files.sort_by(|a, b| b.file_timestamp.cmp(&a.file_timestamp));
	files
}

#[cfg(test)]
mod tests {
	use super::*;

	const FIXTURE: &str = include_str!("../tests/fixtures/session-v4.jsonl");

	#[test]
	fn parses_header_and_entries() {
		let t = Transcript::parse(FIXTURE).unwrap();
		assert_eq!(t.header.version, 4);
		assert_eq!(t.header.id, "019f0000-1111-7000-aaaa-000000000001");
		assert_eq!(t.header.title.as_deref(), Some("Fixture Session"));
		assert_eq!(t.entries.len(), 4);
		assert_eq!(t.entries[0].kind, "model_change");
		assert_eq!(t.entries[0].parent_id(), Some(&Value::Null));
		assert_eq!(t.entries[1].parent_id(), Some(&Value::String("aaaa0001".into())));
		assert_eq!(t.entries[3].kind, "custom");
		assert!(t.entries[3].id.is_none());
	}

	#[test]
	fn round_trip_is_loss_free() {
		let t = Transcript::parse(FIXTURE).unwrap();
		let out = t.to_jsonl().unwrap();
		// Compare semantically per line: key order inside objects is preserved
		// for unknown fields, but known fields are re-emitted first, so byte
		// equality is not guaranteed. No data may be lost or altered.
		let original: Vec<Value> = FIXTURE
			.lines()
			.filter(|l| !l.trim().is_empty())
			.map(|l| serde_json::from_str(l).unwrap())
			.collect();
		let reparsed: Vec<Value> = out
			.lines()
			.map(|l| serde_json::from_str(l).unwrap())
			.collect();
		assert_eq!(original, reparsed);
	}

	#[test]
	fn rejects_non_session_first_line() {
		assert!(Transcript::parse("{\"type\":\"model_change\",\"id\":\"x\"}\n").is_err());
		assert!(Transcript::parse("").is_err());
	}

	#[test]
	fn lists_transcripts_newest_first() {
		let tmp = tempfile::tempdir().unwrap();
		let dir = tmp.path();
		for name in [
			"2026-07-18T13-22-00-198Z_019f0000-1111-7000-aaaa-000000000001.jsonl",
			"2026-07-19T14-43-57-526Z_019f0000-2222-7000-bbbb-000000000002.jsonl",
			"not-a-transcript.txt",
			".gjc-managed-session-scope.v2.json",
		] {
			std::fs::write(dir.join(name), "{}\n").unwrap();
		}
		std::fs::create_dir(dir.join(".gjc-managed-session-internal")).unwrap();

		let files = list_transcripts(dir);
		assert_eq!(files.len(), 2);
		assert_eq!(files[0].session_id, "019f0000-2222-7000-bbbb-000000000002");
		assert_eq!(files[1].file_timestamp, "2026-07-18T13-22-00-198Z");
	}
}
