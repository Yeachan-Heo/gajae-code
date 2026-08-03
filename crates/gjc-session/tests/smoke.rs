//! End-to-end smoke test: build a synthetic sessions root with a managed
//! scope (binding + transcripts), then list and parse it through the crate's
//! public API only.

use gjc_session::scope::{
	MANAGED_SESSION_BINDING_FILE, ScopePlatform, list_scopes, scope_directory_name,
	scope_directory_path,
};
use gjc_session::transcript::{Transcript, list_transcripts};

const FIXTURE: &str = include_str!("fixtures/session-v4.jsonl");

#[test]
fn lists_and_parses_a_synthetic_sessions_root() {
	let tmp = tempfile::tempdir().unwrap();
	let sessions_root = tmp.path().join("sessions");
	let cwd = "/tmp/fixture-project";

	let scope_dir = scope_directory_path(&sessions_root, cwd);
	assert_eq!(
		scope_dir.file_name().unwrap().to_str().unwrap(),
		scope_directory_name(ScopePlatform::current(), cwd)
	);
	std::fs::create_dir_all(&scope_dir).unwrap();

	let digest = scope_directory_name(ScopePlatform::current(), cwd);
	let digest = digest.strip_prefix("v2-").unwrap();
	std::fs::write(
        scope_dir.join(MANAGED_SESSION_BINDING_FILE),
        format!(
            "{{\"schemaVersion\":1,\"layoutVersion\":2,\"identityVersion\":1,\"platform\":\"posix\",\"canonicalPath\":\"{cwd}\",\"identityDigest\":\"{digest}\"}}\n"
        ),
    )
    .unwrap();
	std::fs::write(
		scope_dir.join("2026-07-18T13-22-00-198Z_019f0000-1111-7000-aaaa-000000000001.jsonl"),
		FIXTURE,
	)
	.unwrap();

	let scopes = list_scopes(&sessions_root);
	assert_eq!(scopes.len(), 1);
	let (found_dir, binding) = &scopes[0];
	assert_eq!(found_dir, &scope_dir);
	let binding = binding.as_ref().expect("binding parses");
	assert_eq!(binding.canonical_path, cwd);
	assert_eq!(binding.identity_digest, digest);

	let transcripts = list_transcripts(found_dir);
	assert_eq!(transcripts.len(), 1);
	assert_eq!(transcripts[0].session_id, "019f0000-1111-7000-aaaa-000000000001");

	let transcript = Transcript::read(&transcripts[0].path).unwrap();
	assert_eq!(transcript.header.cwd, cwd);
	assert_eq!(transcript.entries.len(), 4);
}
