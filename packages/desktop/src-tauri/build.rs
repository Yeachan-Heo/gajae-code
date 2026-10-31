fn main() {
	println!("cargo:rerun-if-env-changed=GJC_DESKTOP_BUN");
	if let Ok(path) = std::env::var("GJC_DESKTOP_BUN") {
		assert!(
			std::path::Path::new(&path).is_absolute(),
			"GJC_DESKTOP_BUN must be an absolute path"
		);
		println!("cargo:rustc-env=GJC_DESKTOP_BUN={path}");
	}
	tauri_build::build();
}
