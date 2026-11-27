/// Console input/output code pages, as returned by `GetConsoleCP` and
/// `GetConsoleOutputCP`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ConsoleCodePages {
	pub input:  u32,
	pub output: u32,
}

/// Re-assert `baseline` on a console whose current code pages are `current`.
///
/// A child process that shares the console (the bash tool's commands do) can
/// call `SetConsoleOutputCP`/`SetConsoleCP` and exit without restoring them;
/// the host's UTF-8 output is then decoded with the child's code page (#7760).
/// Only a drifted page is written, so an unchanged console sees no call.
pub fn restore_code_pages(
	baseline: ConsoleCodePages,
	current: ConsoleCodePages,
	set_input: impl FnOnce(u32),
	set_output: impl FnOnce(u32),
) {
	if current.output != baseline.output {
		set_output(baseline.output);
	}
	if current.input != baseline.input {
		set_input(baseline.input);
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	const UTF8: ConsoleCodePages = ConsoleCodePages { input: 65001, output: 65001 };

	fn restored(current: ConsoleCodePages) -> (Option<u32>, Option<u32>) {
		let (mut input, mut output) = (None, None);
		restore_code_pages(UTF8, current, |page| input = Some(page), |page| output = Some(page));
		(input, output)
	}

	#[test]
	fn restores_only_the_drifted_code_page() {
		assert_eq!(restored(ConsoleCodePages { input: 65001, output: 1252 }), (None, Some(65001)));
		assert_eq!(restored(ConsoleCodePages { input: 949, output: 65001 }), (Some(65001), None));
		assert_eq!(
			restored(ConsoleCodePages { input: 949, output: 1252 }),
			(Some(65001), Some(65001))
		);
	}

	#[test]
	fn leaves_an_unchanged_console_untouched() {
		assert_eq!(restored(UTF8), (None, None));
	}
}
