import { logger } from "@gajae-code/utils";
import { type ExecResult, execCommand } from "../../exec/exec";
import type { ExtensionContext, InputEvent, InputEventResult } from "./types";

export const OOO_BRIDGE_RECURSION_ENV = "_OUROBOROS_GJC_BRIDGE_DEPTH";
export const OOO_BRIDGE_CONTINUE_EXIT_CODE = 78;

export interface ExactPrefixCommandBridgeOptions {
	/** Bare command prefix to intercept, without trailing whitespace. */
	prefix: string;
	/** Command executable to run when the prefix matches. */
	command: string;
	/** Arguments inserted before the intercepted input text. */
	args?: string[];
	/** Environment variable used as the recursion-depth guard. */
	recursionEnv?: string;
	/** Exit code that maps to extension pass-through instead of handled input. */
	continueExitCode?: number;
	/** Optional dispatch timeout in milliseconds. */
	timeout?: number;
	/** Dispatch implementation. Defaults to the shared command executor in the extension context cwd. */
	dispatch?: (
		command: string,
		args: string[],
		ctx: ExtensionContext,
		options: { timeout?: number },
	) => Promise<ExecResult>;
}

function isExactPrefixMatch(text: string, prefix: string): boolean {
	return text === prefix || text.startsWith(`${prefix} `);
}

function hasActiveRecursionGuard(envName: string): boolean {
	const value = process.env[envName];
	if (value === undefined || value === "") return false;
	const depth = Number(value);
	return Number.isFinite(depth) ? depth > 0 : true;
}

function nextRecursionDepth(envName: string): string {
	const current = Number(process.env[envName] ?? "0");
	return String(Number.isFinite(current) && current >= 0 ? current + 1 : 1);
}

/**
 * Build an extension `input` handler for an exact-prefix command bridge.
 *
 * Matching input is passed to `command` as `args + [event.text]`. A zero exit code
 * handles the input, `continueExitCode` returns pass-through, and any other
 * non-zero exit code surfaces an error and handles the input so the failed
 * command is not forwarded to the model. The recursion
 * guard prevents extension-originated or nested dispatch from re-entering the
 * bridge while the child command runs.
 */
export function createExactPrefixCommandBridge(options: ExactPrefixCommandBridgeOptions) {
	const recursionEnv = options.recursionEnv ?? OOO_BRIDGE_RECURSION_ENV;
	const continueExitCode = options.continueExitCode ?? OOO_BRIDGE_CONTINUE_EXIT_CODE;
	const args = options.args ?? [];
	const dispatch =
		options.dispatch ??
		((command, commandArgs, ctx, execOptions) => execCommand(command, commandArgs, ctx.cwd, execOptions));

	return async (event: InputEvent, ctx: ExtensionContext): Promise<InputEventResult> => {
		if (!isExactPrefixMatch(event.text, options.prefix)) return {};
		if (event.source === "extension" || hasActiveRecursionGuard(recursionEnv)) return {};

		const previousDepth = process.env[recursionEnv];
		process.env[recursionEnv] = nextRecursionDepth(recursionEnv);
		try {
			const result = await dispatch(options.command, [...args, event.text], ctx, { timeout: options.timeout });
			if (result.code === 0) return { handled: true };
			if (result.code === continueExitCode) return {};

			const output =
				result.stderr.trim() || result.stdout.trim() || `${options.command} exited with code ${result.code}`;
			logger.error("Exact-prefix command bridge dispatch failed", {
				command: options.command,
				code: result.code,
				prefix: options.prefix,
				error: output,
			});
			ctx.ui.notify(output, "error");
			return { handled: true };
		} finally {
			if (previousDepth === undefined) {
				delete process.env[recursionEnv];
			} else {
				process.env[recursionEnv] = previousDepth;
			}
		}
	};
}

export function createOuroborosOooBridge() {
	return createExactPrefixCommandBridge({
		prefix: "ooo",
		command: "ouroboros",
		args: ["dispatch"],
	});
}
