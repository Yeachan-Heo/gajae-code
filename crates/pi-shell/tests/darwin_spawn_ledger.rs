//! Regression coverage for fast-exiting and entitled children with ownership
//! enabled.
#![cfg(target_os = "macos")]

use std::fs;

use hmac::{Hmac, Mac};
use pi_shell::{
	cancel::CancelToken,
	shell::{Shell, ShellOptions, ShellRunOptions},
};
use sha2::Sha256;

#[tokio::test]
async fn fast_and_entitled_children_preserve_runtime_and_signed_ledger() {
	let path = std::env::temp_dir().join(format!("pi-shell-spawn-{}.jsonl", std::process::id()));
	let token = "spawn-regression-token";
	let shell = Shell::new(Some(ShellOptions {
		ownership_ledger_path: Some(path.to_string_lossy().into_owned()),
		ownership_ledger_token: Some(token.to_owned()),
		..ShellOptions::default()
	}));
	for _ in 0..200 {
		let result = shell
			.run(
				ShellRunOptions {
					command: "/usr/bin/true".to_owned(),
					timeout_ms: Some(10_000),
					..ShellRunOptions::default()
				},
				None,
				CancelToken::default(),
			)
			.await
			.expect("run fast child");
		assert_eq!(result.exit_code, Some(0));
		assert!(!result.timed_out);
	}
	let result = shell
		.run(
			ShellRunOptions {
				command: "/usr/bin/top -l 1".to_owned(),
				timeout_ms: Some(30_000),
				..ShellRunOptions::default()
			},
			None,
			CancelToken::default(),
		)
		.await
		.expect("run entitled child");
	assert_eq!(result.exit_code, Some(0));
	assert!(!result.timed_out);
	let ledger = fs::read_to_string(&path).expect("read ledger");
	assert!(!ledger.is_empty(), "live children must publish identity evidence");
	for line in ledger.lines() {
		let record: serde_json::Value = serde_json::from_str(line).expect("ledger JSON");
		let incarnation = record["incarnation"].as_str().expect("incarnation");
		assert!(incarnation.starts_with("darwin:"));
		let unique_id = record["darwinUniqueId"].as_str().unwrap_or("");
		let payload = format!("{}:{incarnation}:{unique_id}", record["pid"]);
		let mut mac = Hmac::<Sha256>::new_from_slice(token.as_bytes()).expect("HMAC key");
		mac.update(payload.as_bytes());
		let expected: String = mac
			.finalize()
			.into_bytes()
			.iter()
			.map(|byte| format!("{byte:02x}"))
			.collect();
		assert_eq!(record["signature"].as_str(), Some(expected.as_str()));
	}
	drop(shell);
	fs::remove_file(path).expect("remove ledger");
}
