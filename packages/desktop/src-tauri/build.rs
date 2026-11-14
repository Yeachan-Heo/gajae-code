fn main() {
	// option_env! embeds these release-owned settings; runtime environment and
	// renderer input must never select an update server or verification key.
	println!("cargo:rerun-if-env-changed=GJC_DESKTOP_UPDATE_ENDPOINT");
	println!("cargo:rerun-if-env-changed=GJC_DESKTOP_UPDATE_PUBLIC_KEY");
	println!("cargo:rerun-if-env-changed=GJC_DESKTOP_BUN");
	if let Ok(path) = std::env::var("GJC_DESKTOP_BUN") {
		assert!(
			std::path::Path::new(&path).is_absolute(),
			"GJC_DESKTOP_BUN must be an absolute path"
		);
		println!("cargo:rustc-env=GJC_DESKTOP_BUN={path}");
	}
	let package_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
		.join("../../utils/package.json");
	println!("cargo:rerun-if-changed={}", package_path.display());
	let package: serde_json::Value = serde_json::from_str(
		&std::fs::read_to_string(package_path).expect("Cannot read bundled gjc package version"),
	).expect("Invalid bundled gjc package manifest");
	let version = package["version"].as_str().expect("Bundled gjc version is missing");
	assert!(!version.is_empty() && !version.chars().any(char::is_control), "Invalid bundled gjc version");
	println!("cargo:rustc-env=GJC_DESKTOP_BUNDLED_GJC_VERSION={version}");
	tauri_build::build();
}
