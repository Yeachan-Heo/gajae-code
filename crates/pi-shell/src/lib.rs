pub mod cancel;
pub mod fixup;
pub mod minimizer;
mod output_decode;
pub mod process;
pub mod shell;
#[cfg(windows)]
pub mod windows;

pub use brush_core::commands::{ChildSessionAction, CommandWindowControlExt, child_session_action};
pub use shell::{
	MinimizerResult, Shell, ShellExecuteOptions, ShellExecuteResult, ShellOptions, ShellRunOptions,
	ShellRunResult, StreamSinks, execute_shell, execute_shell_streams,
};
