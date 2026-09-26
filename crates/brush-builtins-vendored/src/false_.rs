// Vendored from can1357/oh-my-pi@a85bd5228d9f0f619deade1db78fa49420a721e1:crates/pi-builtins/src/false_.rs — MIT (c) 2025 Mario Zechner, 2025-2026 Can Bölük, 2026 Stencil Labs, Inc. Modified for gajae-code: yes, retained a local man-page guard test.
use brush_core::{ExecutionResult, builtins};

/// Return exit code 1.
pub(crate) struct FalseCommand {}

impl builtins::SimpleCommand for FalseCommand {
	fn get_content(
		_name: &str,
		content_type: builtins::ContentType,
		_options: &builtins::ContentOptions,
	) -> Result<String, brush_core::Error> {
		match content_type {
			builtins::ContentType::DetailedHelp => Ok("Returns a failure exit status.".into()),
			builtins::ContentType::ShortUsage => Ok("false".into()),
			builtins::ContentType::ShortDescription => Ok("false - fail".into()),
			builtins::ContentType::ManPage => Ok(
				"NAME\n    false - Return an unsuccessful result.\n\nSYNOPSIS\n    false\n\nDESCRIPTION\n    Return an unsuccessful result.\n\n    Exit Status:\n    Always fails.\n\nSEE ALSO\n    bash(1)\n"
					.into(),
			),
		}
	}

	fn execute<SE: brush_core::ShellExtensions, I: Iterator<Item = S>, S: AsRef<str>>(
		_context: brush_core::ExecutionContext<'_, SE>,
		_args: I,
	) -> Result<ExecutionResult, brush_core::Error> {
		Ok(ExecutionResult::general_error())
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn man_page_describes_failure() {
		let page = <FalseCommand as builtins::SimpleCommand>::get_content(
			"false",
			builtins::ContentType::ManPage,
			&builtins::ContentOptions::default(),
		)
		.expect("false man page");

		assert!(page.starts_with("NAME\n    false - Return an unsuccessful result."));
		assert!(page.contains("Always fails."));
	}
}
