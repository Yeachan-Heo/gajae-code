// Vendored from oh-my-pi (MIT) crates/pi-natives/src/crash_handler.rs @
// a85bd5228d9f0f619deade1db78fa49420a721e1 Local modifications: preserve GJC
// opt-in panic diagnostics and report alloc failures only under the same
// environment gate.

use std::{
	alloc::Layout,
	backtrace::Backtrace,
	path::PathBuf,
	process,
	sync::{
		Once,
		atomic::{AtomicBool, Ordering},
	},
	time::{SystemTime, UNIX_EPOCH},
};

use napi_derive::napi;

static INIT: Once = Once::new();
static ALLOC_HOOK_ACTIVE: AtomicBool = AtomicBool::new(false);
#[cfg(test)]
static HOOKS_REGISTERED: AtomicBool = AtomicBool::new(false);
const ENABLE_ENV: &str = "GJC_NATIVE_CRASH_DIAGNOSTICS";
const DIR_ENV: &str = "GJC_CRASH_DIAGNOSTICS_DIR";

/// Installs Rust panic and allocation-error hooks only when
/// `GJC_NATIVE_CRASH_DIAGNOSTICS` is set.
///
/// This is an opt-in structured panic report, not a minidump/signal handler.
/// It intentionally avoids always-on work and does not attempt to recover from
/// panics crossing N-API boundaries.
#[napi(js_name = "initNativeCrashDiagnostics")]
pub fn init_native_crash_diagnostics() -> bool {
	install_hooks_if_enabled()
}

fn install_hooks_if_enabled() -> bool {
	if !enabled() {
		return false;
	}

	INIT.call_once(|| {
		let previous = std::panic::take_hook();
		std::panic::set_hook(Box::new(move |info| {
			write_panic_report(info);
			previous(info);
		}));

		std::alloc::set_alloc_error_hook(|layout| {
			write_alloc_failure_line(std::io::stderr(), layout.size());
			if ALLOC_HOOK_ACTIVE.swap(true, Ordering::AcqRel) {
				process::abort();
			}
			write_alloc_report(layout);
			process::abort();
		});
		#[cfg(test)]
		HOOKS_REGISTERED.store(true, Ordering::Release);
	});

	true
}

fn enabled() -> bool {
	matches!(std::env::var(ENABLE_ENV).ok().as_deref(), Some("1" | "true" | "yes"))
}

fn crash_diagnostics_dir() -> Option<PathBuf> {
	if let Some(directory) = std::env::var_os(DIR_ENV) {
		return Some(PathBuf::from(directory));
	}

	#[cfg(windows)]
	let home = std::env::var_os("USERPROFILE")
		.filter(|path| !path.is_empty())
		.or_else(|| {
			let mut path = std::env::var_os("HOMEDRIVE")?;
			path.push(std::env::var_os("HOMEPATH")?);
			Some(path)
		});
	#[cfg(not(windows))]
	let home = std::env::var_os("HOME").filter(|path| !path.is_empty());

	Some(PathBuf::from(home?).join(".gjc").join("logs"))
}

fn write_panic_report(info: &std::panic::PanicHookInfo<'_>) {
	let Some(dir) = crash_diagnostics_dir() else {
		return;
	};
	if std::fs::create_dir_all(&dir).is_err() {
		return;
	}

	let now_ms = unix_millis();
	let path = dir.join(format!("{now_ms}-native-panic-{}.json", process::id()));
	let payload = panic_payload(info);
	let location = info.location().map_or_else(
		|| "<unknown>".to_string(),
		|location| format!("{}:{}:{}", location.file(), location.line(), location.column()),
	);
	let report = serde_json::json!({
		"schemaVersion": 1,
		"kind": "native",
		"class": "native_panic",
		"crashed": true,
		"pid": process::id(),
		"payload": payload,
		"location": location,
	});
	let _ = std::fs::write(path, format!("{report}\n"));
}

fn format_alloc_report(layout: Layout) -> serde_json::Value {
	serde_json::json!({
		"schemaVersion": 1,
		"kind": "native",
		"class": "native_alloc",
		"crashed": true,
		"pid": process::id(),
		"requestedBytes": layout.size(),
		"alignment": layout.align(),
		"backtrace": Backtrace::force_capture().to_string(),
	})
}

fn write_alloc_report(layout: Layout) {
	let Some(dir) = crash_diagnostics_dir() else {
		return;
	};
	if std::fs::create_dir_all(&dir).is_err() {
		return;
	}

	let now_ms = unix_millis();
	let path = dir.join(format!("{now_ms}-native-alloc-{}.json", process::id()));
	let report = format_alloc_report(layout);
	let _ = std::fs::write(path, format!("{report}\n"));
}

fn write_alloc_failure_line(mut output: impl std::io::Write, size: usize) {
	let _ = output.write_all(b"memory allocation of ");
	let mut digits = [0u8; usize::MAX.ilog10() as usize + 1];
	let mut position = digits.len();
	let mut value = size;
	if value == 0 {
		position -= 1;
		digits[position] = b'0';
	} else {
		while value > 0 {
			position -= 1;
			digits[position] = b'0' + (value % 10) as u8;
			value /= 10;
		}
	}
	let _ = output.write_all(&digits[position..]);
	let _ = output.write_all(b" bytes failed\n");
}

fn unix_millis() -> u128 {
	SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.map_or(0, |duration| duration.as_millis())
}

fn panic_payload(info: &std::panic::PanicHookInfo<'_>) -> String {
	if let Some(value) = info.payload().downcast_ref::<&str>() {
		return (*value).to_string();
	}
	if let Some(value) = info.payload().downcast_ref::<String>() {
		return value.clone();
	}
	"<non-string panic payload>".to_string()
}

#[cfg(test)]
mod tests {
	use std::{
		alloc::Layout,
		fs,
		path::PathBuf,
		process::{Command, Output},
		sync::atomic::{AtomicU64, Ordering},
	};

	use super::{
		DIR_ENV, ENABLE_ENV, HOOKS_REGISTERED, format_alloc_report, install_hooks_if_enabled,
		unix_millis, write_alloc_failure_line,
	};

	const CHILD_MODE_ENV: &str = "GJC_NATIVE_CRASH_DIAGNOSTICS_TEST_MODE";
	static NEXT_HOME: AtomicU64 = AtomicU64::new(0);

	struct IsolatedHome(PathBuf);

	impl IsolatedHome {
		fn new() -> Self {
			let suffix = NEXT_HOME.fetch_add(1, Ordering::Relaxed);
			let path = std::env::temp_dir().join(format!(
				"gjc-crash-hook-test-{}-{}-{suffix}",
				std::process::id(),
				unix_millis(),
			));
			fs::create_dir_all(&path).expect("create isolated crash-hook home");
			Self(path)
		}

		fn logs(&self) -> PathBuf {
			self.0.join(".gjc").join("logs")
		}
	}

	impl Drop for IsolatedHome {
		fn drop(&mut self) {
			let _ = fs::remove_dir_all(&self.0);
		}
	}

	fn run_crash_child(mode: &str, home: &IsolatedHome) -> Output {
		let mut command = Command::new(std::env::current_exe().expect("test executable path"));
		command
			.args(["--exact", "crash::tests::crash_hook_child_process", "--nocapture"])
			.env(CHILD_MODE_ENV, mode)
			.env_remove(ENABLE_ENV)
			.env_remove(DIR_ENV)
			.env("HOME", &home.0)
			.env("USERPROFILE", &home.0)
			.env_remove("HOMEDRIVE")
			.env_remove("HOMEPATH");
		if mode == "enabled" {
			command.env(ENABLE_ENV, "1");
		}
		command
			.output()
			.expect("run isolated crash-hook test child")
	}

	#[test]
	fn panic_hook_is_inert_without_the_opt_in_environment() {
		let home = IsolatedHome::new();
		let child = run_crash_child("disabled", &home);
		assert!(!child.status.success(), "child panic must remain uncaught");
		assert!(
			!home.0.join(".gjc").exists(),
			"disabled panic hook created a report under the user's GJC directory"
		);
	}

	#[test]
	fn opted_in_panic_report_uses_the_gjc_home_directory() {
		let home = IsolatedHome::new();
		let child = run_crash_child("enabled", &home);
		assert!(!child.status.success(), "child panic must remain uncaught");

		let entries: Vec<_> = fs::read_dir(home.logs())
			.expect("opted-in diagnostics create ~/.gjc/logs")
			.map(|entry| entry.expect("read crash report path").path())
			.collect();
		assert_eq!(entries.len(), 1, "write one panic report");
		let report: serde_json::Value =
			serde_json::from_slice(&fs::read(&entries[0]).expect("read panic report"))
				.expect("panic report is JSON");
		let golden: serde_json::Value = serde_json::from_str(include_str!(
			"../../../packages/natives/test/fixtures/goldens/crash/panic-report.json"
		))
		.expect("panic report golden is JSON");
		for field in ["schemaVersion", "kind", "class", "crashed", "payload"] {
			assert_eq!(report[field], golden[field], "panic report field {field}");
		}
	}

	#[test]
	fn alloc_failure_report_matches_golden_size_alignment_and_backtrace() {
		let layout = Layout::from_size_align(7714, 8).expect("valid test allocation layout");
		let report = format_alloc_report(layout);
		let golden: serde_json::Value = serde_json::from_str(include_str!(
			"../../../packages/natives/test/fixtures/goldens/crash/alloc-report.json"
		))
		.expect("allocation report golden is JSON");
		for field in ["class", "requestedBytes", "alignment"] {
			assert_eq!(report[field], golden[field], "allocation report field {field}");
		}
		assert!(
			report["backtrace"]
				.as_str()
				.is_some_and(|trace| !trace.is_empty())
		);
	}

	#[test]
	fn alloc_failure_line_matches_rust_default_without_heap_formatting() {
		let mut output = Vec::new();
		write_alloc_failure_line(&mut output, 7714);
		assert_eq!(output, b"memory allocation of 7714 bytes failed\n");
	}

	#[test]
	fn crash_hook_child_process() {
		match std::env::var(CHILD_MODE_ENV).as_deref() {
			Ok("disabled") => {
				assert!(!install_hooks_if_enabled());
				assert!(!HOOKS_REGISTERED.load(Ordering::Acquire));
				panic!("crash diagnostics disabled sentinel");
			},
			Ok("enabled") => {
				assert!(install_hooks_if_enabled());
				assert!(HOOKS_REGISTERED.load(Ordering::Acquire));
				panic!("opt-in crash diagnostics test");
			},
			_ => {},
		}
	}
}
