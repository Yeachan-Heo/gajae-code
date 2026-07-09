import * as path from "node:path";
import type { Subprocess } from "bun";

/**
 * Command-hook runtime: GJC itself spawns the declared, root-confined command
 * with the `tool_call` event JSON on stdin and reads an optional
 * `{block,reason}` verdict from stdout. This is the sanctioned seam for
 * external governance/policy tools; plugin hook modules never gain an exec
 * capability (the constrained API keeps denying `exec`), and the spawn spec is
 * validated by the same confinement policy as stdio MCP servers
 * (mcp-policy.ts) plus an explicit install-time operator approval.
 *
 * Semantics (mirrors command hooks in other agent runtimes): fail-closed.
 * Spawn error, timeout, non-zero exit, or unparseable stdout all block the
 * tool call. Empty stdout + exit 0 allows. `{"block":true,"reason":"..."}`
 * blocks with that reason. v1 supports the `tool_call` event only (enforced
 * by the manifest schema).
 */

export const COMMAND_HOOK_DEFAULT_TIMEOUT_MS = 10_000;

export interface CommandHookSpec {
	plugin: string;
	name: string;
	event: string;
	command: string;
	args?: string[];
	timeoutMs?: number;
	pluginRoot: string;
}

interface CommandHookSessionManagerLike {
	getSessionId?: () => string;
	getSessionFile?: () => string | undefined;
}

interface CommandHookContextLike {
	cwd?: string;
	sessionManager?: CommandHookSessionManagerLike;
}

interface CommandHookBlockVerdict {
	block: true;
	reason: string;
}

type CommandHookOutcome =
	| { kind: "allow" }
	| { kind: "block"; verdict: CommandHookBlockVerdict }
	| { kind: "failure"; detail: string };

/**
 * Minimal environment for command-hook children. Parity with the no-inherit
 * stdio MCP policy (runtime-mcp/transports/stdio.ts buildMinimalStdioEnv):
 * only OS-level keys needed to locate/run an interpreter are copied from the
 * host; API keys/tokens/secrets are withheld.
 */
function buildMinimalCommandHookEnv(): Record<string, string> {
	const allow = [
		"PATH",
		"HOME",
		"TMPDIR",
		"TEMP",
		"TMP",
		"LANG",
		"LC_ALL",
		"LC_CTYPE",
		"SHELL",
		"USER",
		"SystemRoot",
		"SYSTEMROOT",
		"PATHEXT",
		"COMSPEC",
		"WINDIR",
	];
	const env: Record<string, string> = {};
	for (const key of allow) {
		const value = Bun.env[key];
		if (typeof value === "string") env[key] = value;
	}
	return env;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Bare allowlisted launchers stay bare (PATH lookup); paths resolve within the plugin root. */
function resolveCommandArgv(spec: CommandHookSpec): string[] {
	const head = spec.command.includes("/") ? path.resolve(spec.pluginRoot, spec.command) : spec.command;
	return [head, ...(spec.args ?? [])];
}

function buildPayload(spec: CommandHookSpec, event: unknown, ctx: CommandHookContextLike | undefined): string {
	const sessionId = ctx?.sessionManager?.getSessionId?.();
	const sessionFile = ctx?.sessionManager?.getSessionFile?.();
	return JSON.stringify({
		event: spec.event,
		plugin: spec.plugin,
		hook: spec.name,
		data: event ?? {},
		session: {
			id: typeof sessionId === "string" ? sessionId : "",
			file: typeof sessionFile === "string" ? sessionFile : "",
		},
		cwd: typeof ctx?.cwd === "string" ? ctx.cwd : "",
	});
}

async function runCommandHook(
	spec: CommandHookSpec,
	event: unknown,
	ctx: CommandHookContextLike | undefined,
): Promise<CommandHookOutcome> {
	let payload: string;
	try {
		payload = buildPayload(spec, event, ctx);
	} catch (error) {
		return {
			kind: "failure",
			detail: `payload serialization: ${error instanceof Error ? error.message : String(error)}`,
		};
	}

	const timeoutMs = spec.timeoutMs ?? COMMAND_HOOK_DEFAULT_TIMEOUT_MS;
	let proc: Subprocess;
	try {
		proc = Bun.spawn({
			cmd: resolveCommandArgv(spec),
			cwd: spec.pluginRoot,
			env: buildMinimalCommandHookEnv(),
			stdin: Buffer.from(payload, "utf8"),
			stdout: "pipe",
			stderr: "ignore",
		});
	} catch (error) {
		return { kind: "failure", detail: `spawn: ${error instanceof Error ? error.message : String(error)}` };
	}

	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		try {
			proc.kill();
		} catch {
			// already exited
		}
	}, timeoutMs);
	try {
		const [exitCode, stdout] = await Promise.all([
			proc.exited,
			proc.stdout instanceof ReadableStream ? new Response(proc.stdout).text() : Promise.resolve(""),
		]);
		if (timedOut) return { kind: "failure", detail: `timeout after ${timeoutMs}ms` };
		if (exitCode !== 0) return { kind: "failure", detail: `exit code ${exitCode}` };
		const out = stdout.trim();
		if (!out) return { kind: "allow" };
		let parsed: unknown;
		try {
			parsed = JSON.parse(out);
		} catch {
			return { kind: "failure", detail: "unparseable verdict on stdout" };
		}
		if (isRecord(parsed) && parsed.block === true) {
			const reason =
				typeof parsed.reason === "string" && parsed.reason.length > 0
					? parsed.reason
					: `blocked by plugin command hook "${spec.plugin}/${spec.name}"`;
			return { kind: "block", verdict: { block: true, reason } };
		}
		return { kind: "allow" };
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Build the constrained-hook handler for a declared `tool_call` command hook
 * (fail-closed verdict semantics; see the module doc).
 */
export function createCommandHookHandler(spec: CommandHookSpec): (...args: unknown[]) => Promise<unknown> {
	return async (event: unknown, ctx?: unknown) => {
		const outcome = await runCommandHook(spec, event, ctx as CommandHookContextLike | undefined);
		if (outcome.kind === "failure") {
			return {
				block: true,
				reason: `Plugin command hook "${spec.plugin}/${spec.name}" failed (fail-closed): ${outcome.detail}`,
			};
		}
		if (outcome.kind === "block") return outcome.verdict;
		return undefined;
	};
}
