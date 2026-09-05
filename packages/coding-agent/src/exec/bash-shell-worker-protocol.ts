import type { MinimizerOptions, ShellOptions, ShellRunOptions, ShellRunResult } from "@gajae-code/natives";

export const BASH_SHELL_WORKER_ARG = "--internal-bash-shell-worker";

export type IsolatedShellOptions = Pick<ShellOptions, "sessionEnv" | "snapshotPath"> & {
	minimizer?: MinimizerOptions;
};

export type IsolatedShellRunOptions = Omit<ShellRunOptions, "signal">;

export type IsolatedShellRunResult = ShellRunResult & {
	/** POSIX signal that terminated the isolated shell worker, when applicable. */
	signal?: string;
};

export type BashShellWorkerRequest =
	| { type: "init"; options?: IsolatedShellOptions }
	| { type: "run"; id: number; options: IsolatedShellRunOptions }
	| { type: "abort"; id: number }
	| { type: "close"; id: number };

export type BashShellWorkerResponse =
	| { type: "ready" }
	| { type: "chunk"; id: number; chunk: string }
	| { type: "result"; id: number; result: ShellRunResult }
	| { type: "void"; id: number }
	| { type: "error"; id?: number; message: string };
