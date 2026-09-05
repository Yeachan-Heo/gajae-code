import type { MinimizerOptions, ShellOptions, ShellRunOptions, ShellRunResult } from "@gajae-code/natives";

export const BASH_SHELL_WORKER_ARG = "--internal-bash-shell-worker";
export const BASH_SHELL_SUPERVISOR_ARG = "--internal-bash-shell-supervisor";
export const BASH_SHELL_RUNTIME_ARG = "--internal-bash-shell-runtime";

export type IsolatedShellOptions = Pick<ShellOptions, "sessionEnv" | "snapshotPath"> & {
	minimizer?: MinimizerOptions;
	containedProcessGroup?: boolean;
};

export type IsolatedShellRunOptions = Omit<ShellRunOptions, "signal">;

export type IsolatedShellRunResult = ShellRunResult & {
	/** POSIX signal that terminated the isolated shell worker, when applicable. */
	signal?: string;
};

export type BashShellWorkerRequest =
	| {
			type: "init";
			token: string;
			options?: IsolatedShellOptions;
			ownershipLedger?: { path: string; token: string };
	  }
	| { type: "run"; token: string; id: number; options: IsolatedShellRunOptions }
	| { type: "abort"; token: string; id: number }
	| { type: "close"; token: string; id: number };

export type BashShellWorkerResponse =
	| { type: "ready"; token: string; supervisorPid?: number }
	| { type: "chunk"; token: string; id: number; chunk: string }
	| { type: "result"; token: string; id: number; result: IsolatedShellRunResult }
	| { type: "void"; token: string; id: number }
	| { type: "retiring"; token: string; message: string }
	| { type: "error"; token: string; id?: number; message: string };
