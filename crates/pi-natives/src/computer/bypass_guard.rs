#[cfg(test)]
mod tests {
	use std::{fs, path::Path};

	const SIDE_EFFECT_METHODS: &[&str] =
		&[".click(", ".double_click(", ".drag(", ".scroll(", ".type_text(", ".keypress("];

	#[test]
	fn input_controller_side_effect_methods_stay_behind_executor() {
		let computer_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/computer");
		let mut violations = Vec::new();

		for entry in fs::read_dir(&computer_dir).expect("computer module directory is readable") {
			let entry = entry.expect("computer module entry is readable");
			let path = entry.path();
			if path.extension().and_then(|ext| ext.to_str()) != Some("rs") {
				continue;
			}
			let file_name = path
				.file_name()
				.and_then(|name| name.to_str())
				.unwrap_or_default();
			if file_name == "bypass_guard.rs" {
				continue;
			}
			let source = fs::read_to_string(&path).expect("computer module source is readable");
			for method in SIDE_EFFECT_METHODS {
				if !source.contains(method) {
					continue;
				}
				if file_name != "input.rs" && file_name != "executor.rs" {
					violations.push(format!("{file_name} references {method}"));
				}
			}
		}

		assert!(
			violations.is_empty(),
			"InputController side-effect methods must be referenced only in input.rs and \
			 executor.rs: {}",
			violations.join(", ")
		);
	}
}
