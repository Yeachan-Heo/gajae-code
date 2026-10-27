// Vendored from can1357/oh-my-pi@a85bd5228d9f0f619deade1db78fa49420a721e1:crates/pi-builtins/src/true_.rs — MIT (c) 2025 Mario Zechner, 2025-2026 Can Bölük, 2026 Stencil Labs, Inc. Modified for gajae-code: yes, retained a local man-page guard test.
use brush_core::{ExecutionResult, builtins};

/// No-op command. Same with :.
pub(crate) struct TrueCommand {}

const MAN_PAGE: &str = "TRUE(1)\n\nNAME\n    true - return a successful result\n\nSYNOPSIS\n    true\n\nDESCRIPTION\n    The true utility returns a successful exit status.\n";

impl builtins::SimpleCommand for TrueCommand {
	fn get_content(
		_name: &str,
		content_type: builtins::ContentType,
		_options: &builtins::ContentOptions,
	) -> Result<String, brush_core::Error> {
		match content_type {
			builtins::ContentType::DetailedHelp => Ok("Returns a successful exit status.".into()),
			builtins::ContentType::ShortUsage => Ok("true".into()),
			builtins::ContentType::ShortDescription => Ok("true - success".into()),
			builtins::ContentType::ManPage => Ok(MAN_PAGE.into()),
		}
	}

	fn execute<SE: brush_core::ShellExtensions, I: Iterator<Item = S>, S: AsRef<str>>(
		_context: brush_core::ExecutionContext<'_, SE>,
		_args: I,
	) -> Result<ExecutionResult, brush_core::Error> {
		Ok(ExecutionResult::success())
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn man_page_describes_successful_result() {
		let page = <TrueCommand as builtins::SimpleCommand>::get_content(
			"true",
			builtins::ContentType::ManPage,
			&builtins::ContentOptions::default(),
		)
		.expect("true man page");

		assert!(page.starts_with("TRUE(1)\n\nNAME\n"));
		assert!(page.contains("The true utility returns a successful exit status."));
	}
}
