import * as fs from "node:fs";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@gajae-code/agent-core";
import type { Component } from "@gajae-code/tui";
import { ImageProtocol, TERMINAL, Text } from "@gajae-code/tui";
import { getProjectDir, isEnoent, logger, prompt } from "@gajae-code/utils";
import * as z from "zod/v4";
import { AsyncJobManager } from "../async";
import { type BashResult, executeBash } from "../exec/bash-executor";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { buildGjcRuntimeSessionEnv } from "../gjc-runtime/goal-mode-request";
import { GJC_RESTRICTED_ROLE_AGENT_BASH_ENV } from "../gjc-runtime/restricted-role-agent-bash";
import { InternalUrlRouter } from "../internal-urls";
import { truncateToVisualLines } from "../modes/components/visual-truncate";
import { highlightCode, type Theme } from "../modes/theme/theme";
import bashDescription from "../prompts/tools/bash.md" with { type: "text" };
import type { ClientBridgeTerminalExitStatus, ClientBridgeTerminalOutput } from "../session/client-bridge";
import { DEFAULT_MAX_BYTES, streamTailUpdates, TailBuffer } from "../session/streaming-output";
import { renderStatusLine } from "../tui";
import { CachedOutputBlock } from "../tui/output-block";
import { getSixelLineMask } from "../utils/sixel";
import type { ToolSession } from ".";
import { checkBashAllowedPrefixes, normalizeReadOnlyBashCommand } from "./bash-allowed-prefixes";
import { applyBashFixups } from "./bash-command-fixup";
import { type BashInteractiveResult, runInteractiveBashPty } from "./bash-interactive";
import { checkBashInterception } from "./bash-interceptor";
import { canUseInteractiveBashPty } from "./bash-pty-selection";
import { expandInternalUrls, type InternalUrlExpansionOptions } from "./bash-skill-urls";
import { formatStyledTruncationWarning, type OutputMeta, stripOutputNotice } from "./output-meta";
import { resolveToCwd } from "./path-utils";
import { formatToolWorkingDirectory, replaceTabs } from "./render-utils";
import { ToolAbortError, ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";
import { clampTimeout, TOOL_TIMEOUTS } from "./tool-timeouts";

export const BASH_DEFAULT_PREVIEW_LINES = 10;

const BASH_ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DEFAULT_AUTO_BACKGROUND_THRESHOLD_MS = 60_000;
const READ_ONLY_BASH_ENV: Record<string, string> = {
	GREP_OPTIONS: "",
	GREP_COLOR: "",
	GREP_COLORS: "",
	RIPGREP_CONFIG_PATH: "",
};

export async function saveBashOriginalArtifactForTests(
	session: ToolSession,
	originalText: string,
): Promise<string | undefined> {
	try {
		const manager = session.getArtifactManager?.();
		if (manager) return await manager.save(originalText, "bash-original");
		const alloc = await session.allocateOutputArtifact?.("bash-original");
		if (!alloc?.path || !alloc.id) return undefined;
		await Bun.write(alloc.path, originalText);
		return alloc.id;
	} catch {
		return undefined;
	}
}

const bashSchemaBase = z.object({
	command: z.string().describe("command to execute"),
	env: z.record(z.string().regex(BASH_ENV_NAME_PATTERN), z.string()).optional().describe("extra env vars"),
	timeout: z.number().default(300).describe("timeout in seconds, NOT milliseconds (30 = 30s)").optional(),
	cwd: z.string().describe("working directory").optional(),
	pty: z.boolean().describe("run in pty mode").optional(),
});

const bashSchemaWithAsync = bashSchemaBase.extend({
	async: z.boolean().describe("run in background").optional(),
});

type BashToolSchema = typeof bashSchemaBase | typeof bashSchemaWithAsync;

export interface BashToolInput {
	command: string;
	env?: Record<string, string>;
	timeout?: number;
	cwd?: string;

	async?: boolean;
	pty?: boolean;
}

export interface BashToolDetails {
	meta?: OutputMeta;
	timeoutSeconds?: number;
	requestedTimeoutSeconds?: number;
	terminalId?: string;
	async?: {
		state: "running" | "completed" | "failed";
		jobId: string;
		type: "bash";
	};
}

export interface BashToolOptions {}

type ManagedBashJobCompletion =
	| {
			kind: "completed";
			result: AgentToolResult<BashToolDetails>;
	  }
	| {
			kind: "failed";
			error: unknown;
	  };

interface ManagedBashJobHandle {
	jobId: string;
	label: string;
	completion: Promise<ManagedBashJobCompletion>;
	getLatestText: () => string;
	setBackgrounded: (backgrounded: boolean) => void;
}

function normalizeResultOutput(result: BashResult | BashInteractiveResult): string {
	return result.output || "";
}

function isInteractiveResult(result: BashResult | BashInteractiveResult): result is BashInteractiveResult {
	return "timedOut" in result;
}

function normalizeBashEnv(env: Record<string, string> | undefined): Record<string, string> | undefined {
	if (!env || Object.keys(env).length === 0) return undefined;
	const normalized: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (!BASH_ENV_NAME_PATTERN.test(key)) {
			throw new ToolError(`Invalid bash env name: ${key}`);
		}
		normalized[key] = value;
	}
	return normalized;
}

function escapeBashEnvValueForDisplay(value: string): string {
	return value
		.replaceAll("\\", "\\\\")
		.replaceAll("\n", "\\n")
		.replaceAll("\r", "\\r")
		.replaceAll("\t", "\\t")
		.replaceAll('"', '\\"')
		.replaceAll("$", "\\$")
		.replaceAll("`", "\\`");
}

function formatBashEnvAssignments(env: Record<string, string> | undefined): string {
	if (!env || Object.keys(env).length === 0) return "";
	return Object.entries(env)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([key, value]) => `${key}="${escapeBashEnvValueForDisplay(value)}"`)
		.join(" ");
}

function unescapePartialJsonString(value: string): string {
	let output = "";
	for (let index = 0; index < value.length; index += 1) {
		const char = value[index];
		if (char !== "\\") {
			output += char;
			continue;
		}
		const next = value[index + 1];
		if (!next) {
			output += "\\";
			break;
		}
		index += 1;
		switch (next) {
			case '"':
				output += '"';
				break;
			case "\\":
				output += "\\";
				break;
			case "/":
				output += "/";
				break;
			case "b":
				output += "\b";
				break;
			case "f":
				output += "\f";
				break;
			case "n":
				output += "\n";
				break;
			case "r":
				output += "\r";
				break;
			case "t":
				output += "\t";
				break;
			case "u": {
				const hex = value.slice(index + 1, index + 5);
				if (/^[0-9a-fA-F]{4}$/u.test(hex)) {
					output += String.fromCharCode(Number.parseInt(hex, 16));
					index += 4;
				} else {
					output += "\\u";
				}
				break;
			}
			default:
				output += next;
		}
	}
	return output;
}

function extractPartialBashEnv(partialJson: string | undefined): Record<string, string> | undefined {
	if (!partialJson) return undefined;
	const envStart = partialJson.search(/"env"\s*:\s*\{/u);
	if (envStart === -1) return undefined;
	const objectStart = partialJson.indexOf("{", envStart);
	if (objectStart === -1) return undefined;
	const envBody = partialJson.slice(objectStart + 1);
	const env: Record<string, string> = {};
	const matcher = /"([A-Za-z_][A-Za-z0-9_]*)"\s*:\s*"((?:\\.|[^"\\])*)(?:"|$)/gu;
	for (const match of envBody.matchAll(matcher)) {
		env[match[1]!] = unescapePartialJsonString(match[2]!);
	}
	return Object.keys(env).length > 0 ? env : undefined;
}

function formatTimeoutClampNotice(requestedTimeoutSec: number, effectiveTimeoutSec: number): string | undefined {
	return requestedTimeoutSec !== effectiveTimeoutSec
		? `Timeout clamped to ${effectiveTimeoutSec}s (requested ${requestedTimeoutSec}s; allowed range ${TOOL_TIMEOUTS.bash.min}-${TOOL_TIMEOUTS.bash.max}s).`
		: undefined;
}

/**
 * Bash tool implementation.
 *
 * Executes bash commands with optional timeout and working directory.
 */
export class BashTool implements AgentTool<BashToolSchema, BashToolDetails> {
	readonly name = "bash";
	readonly label = "Bash";
	readonly loadMode = "essential";
	readonly description: string;
	readonly parameters: BashToolSchema;
	readonly concurrency = "exclusive";
	readonly strict = true;
	readonly #asyncEnabled: boolean;
	readonly #autoBackgroundEnabled: boolean;
	readonly #autoBackgroundThresholdMs: number;

	constructor(private readonly session: ToolSession) {
		this.#asyncEnabled = this.session.settings.get("async.enabled");
		this.#autoBackgroundEnabled = this.session.settings.get("bash.autoBackground.enabled");
		this.#autoBackgroundThresholdMs = Math.max(
			0,
			Math.floor(
				this.session.settings.get("bash.autoBackground.thresholdMs") ?? DEFAULT_AUTO_BACKGROUND_THRESHOLD_MS,
			),
		);
		this.parameters = this.#asyncEnabled ? bashSchemaWithAsync : bashSchemaBase;
		this.description = prompt.render(bashDescription, {
			asyncEnabled: this.#asyncEnabled,
			autoBackgroundEnabled: this.#autoBackgroundEnabled,
			autoBackgroundThresholdSeconds: Math.max(0, Math.floor(this.#autoBackgroundThresholdMs / 1000)),
			hasAstGrep: this.session.settings.get("astGrep.enabled"),
			hasAstEdit: this.session.settings.get("astEdit.enabled"),
			hasSearch: this.session.settings.get("search.enabled"),
			hasFind: this.session.settings.get("find.enabled"),
			restrictedAllowedPrefixes: this.session.bashAllowedPrefixes,
			restrictionProfile: this.session.bashRestrictionProfile,
		});
	}

	#formatResultOutput(result: BashResult | BashInteractiveResult): string {
		const outputText = normalizeResultOutput(result);
		return outputText || "(no output)";
	}

	#buildResultText(result: BashResult | BashInteractiveResult, timeoutSec: number, outputText: string): string {
		if (result.cancelled) {
			throw new ToolError(normalizeResultOutput(result) || "Command aborted");
		}
		if (isInteractiveResult(result) && result.timedOut) {
			throw new ToolError(normalizeResultOutput(result) || `Command timed out after ${timeoutSec} seconds`);
		}
		if (result.exitCode === undefined) {
			throw new ToolError(`${outputText}\n\nCommand failed: missing exit status`);
		}
		if (result.exitCode !== 0) {
			throw new ToolError(`${outputText}\n\nCommand exited with code ${result.exitCode}`);
		}
		return outputText;
	}

	#buildCompletedResult(
		result: BashResult | BashInteractiveResult,
		timeoutSec: number,
		options: { requestedTimeoutSec?: number; notices?: readonly string[]; terminalId?: string } = {},
	): AgentToolResult<BashToolDetails> {
		const outputLines = [this.#formatResultOutput(result)];
		const notices = options.notices?.filter(Boolean) ?? [];
		if (notices.length > 0) outputLines.push("", ...notices);
		const outputText = outputLines.join("\n");
		const details: BashToolDetails = { timeoutSeconds: timeoutSec };
		if (options.requestedTimeoutSec !== undefined && options.requestedTimeoutSec !== timeoutSec) {
			details.requestedTimeoutSeconds = options.requestedTimeoutSec;
		}
		if (options.terminalId !== undefined) {
			details.terminalId = options.terminalId;
		}
		const resultBuilder = toolResult(details).text(outputText).truncationFromSummary(result, { direction: "tail" });
		this.#buildResultText(result, timeoutSec, outputText);
		return resultBuilder.done();
	}

	#buildBackgroundStartResult(
		jobId: string,
		label: string,
		previewText: string,
		timeoutSec: number,
		options: { requestedTimeoutSec?: number; notices?: readonly string[] } = {},
	): AgentToolResult<BashToolDetails> {
		const details: BashToolDetails = {
			timeoutSeconds: timeoutSec,
			async: { state: "running", jobId, type: "bash" },
		};
		if (options.requestedTimeoutSec !== undefined && options.requestedTimeoutSec !== timeoutSec) {
			details.requestedTimeoutSeconds = options.requestedTimeoutSec;
		}
		const lines: string[] = [];
		const trimmedPreview = previewText.trimEnd();
		if (trimmedPreview.length > 0) {
			lines.push(trimmedPreview, "");
		}
		if (options.notices?.length) {
			lines.push(...options.notices, "");
		}
		lines.push(`Background job ${jobId} started: ${label}`);
		lines.push("Result will be delivered automatically when complete.");
		lines.push(
			`You can use \`job\` to poll until complete, but prefer to continue with another task in the meanwhile if it's not blocking.`,
		);
		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details,
		};
	}

	#extractTextResult(result: AgentToolResult<BashToolDetails>): string {
		return result.content.find(block => block.type === "text")?.text ?? "";
	}

	#startManagedBashJob(options: {
		command: string;
		commandCwd: string;
		timeoutMs: number;
		timeoutSec: number;
		requestedTimeoutSec?: number;
		notices?: readonly string[];

		resolvedEnv?: Record<string, string>;
		onUpdate?: AgentToolUpdateCallback<BashToolDetails>;
		startBackgrounded: boolean;
	}): ManagedBashJobHandle {
		const manager = AsyncJobManager.instance();
		if (!manager) {
			throw new ToolError("Background job manager unavailable for this session.");
		}

		const label = options.command.length > 120 ? `${options.command.slice(0, 117)}...` : options.command;
		let latestText = "";
		let backgrounded = options.startBackgrounded;
		const completion = Promise.withResolvers<ManagedBashJobCompletion>();

		const jobId = manager.register(
			"bash",
			label,
			async ({ jobId, signal: runSignal, reportProgress }) => {
				const { path: artifactPath, id: artifactId } = (await this.session.allocateOutputArtifact?.("bash")) ?? {};
				const tailBuffer = new TailBuffer(DEFAULT_MAX_BYTES);
				try {
					const result = await executeBash(options.command, {
						cwd: options.commandCwd,
						sessionKey: `${this.session.getSessionId?.() ?? ""}:async:${jobId}`,
						timeout: options.timeoutMs,
						signal: runSignal,
						env: options.resolvedEnv,
						artifactPath,
						artifactId,
						oneShot: true,
						ignoreShellPrefix: this.session.bashRestrictionProfile === "read-only",
						disableShellSnapshot: this.session.bashRestrictionProfile === "read-only",
						onChunk: chunk => {
							tailBuffer.append(chunk);
							latestText = tailBuffer.text();
							void reportProgress(latestText, { async: { state: "running", jobId, type: "bash" } });
						},
						onRawChunk: chunk => {
							// Forward the unthrottled sanitized chunk to the async-job
							// substrate so the Monitor tool can read the complete process
							// stream by byte offset, independent of the throttled preview
							// path above.
							manager.appendOutput(jobId, chunk);
						},
						onMinimizedSave: originalText => saveBashOriginalArtifactForTests(this.session, originalText),
					});
					const finalResult = this.#buildCompletedResult(result, options.timeoutSec, {
						requestedTimeoutSec: options.requestedTimeoutSec,
						notices: options.notices ?? [],
					});
					const finalText = this.#extractTextResult(finalResult);
					latestText = finalText;
					completion.resolve({ kind: "completed", result: finalResult });
					await reportProgress(finalText, { async: { state: "completed", jobId, type: "bash" } });
					return finalText;
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					latestText = message;
					completion.resolve({ kind: "failed", error });
					await reportProgress(message, { async: { state: "failed", jobId, type: "bash" } });
					throw error;
				}
			},
			{
				ownerId: this.session.getAgentId?.() ?? undefined,
				onProgress: async (text, details) => {
					latestText = text;
					await options.onUpdate?.({
						content: [{ type: "text", text }],
						details: backgrounded ? ((details ?? {}) as BashToolDetails) : {},
					});
				},
			},
		);

		return {
			jobId,
			label,
			completion: completion.promise,
			getLatestText: () => latestText,
			setBackgrounded: (nextBackgrounded: boolean) => {
				backgrounded = nextBackgrounded;
			},
		};
	}

	async #waitForManagedBashJob(
		job: ManagedBashJobHandle,
		thresholdMs: number,
		signal?: AbortSignal,
	): Promise<ManagedBashJobCompletion | { kind: "running" } | { kind: "aborted" }> {
		if (signal?.aborted) {
			return { kind: "aborted" };
		}

		const waiters: Array<Promise<ManagedBashJobCompletion | { kind: "running" } | { kind: "aborted" }>> = [
			job.completion,
			Bun.sleep(thresholdMs).then(() => ({ kind: "running" as const })),
		];

		if (!signal) {
			return await Promise.race(waiters);
		}

		const { promise: abortedPromise, resolve: resolveAborted } = Promise.withResolvers<{ kind: "aborted" }>();
		const onAbort = () => resolveAborted({ kind: "aborted" });
		signal.addEventListener("abort", onAbort, { once: true });
		waiters.push(abortedPromise);
		try {
			return await Promise.race(waiters);
		} finally {
			signal.removeEventListener("abort", onAbort);
		}
	}

	#resolveAutoBackgroundWaitMs(timeoutMs: number): number {
		if (this.#autoBackgroundThresholdMs <= 0) return 0;
		const timeoutBufferMs = 1_000;
		return Math.max(0, Math.min(this.#autoBackgroundThresholdMs, timeoutMs - timeoutBufferMs));
	}

	/**
	 * Build the fully-prepared parameters for a `bash`-flavored execution
	 * (interceptors, internal URL expansion, env resolution, cwd validation,
	 * timeout clamp). Used by both `execute()` and the public `startMonitorJob`
	 * helper after `AgentSession` has applied the public-tool permission gate, so
	 * Monitor inherits Bash's cwd / env / artifact / interceptor pipeline 1:1.
	 */
	async #prepareBashExecution(
		input: { command: string; env?: Record<string, string>; timeout?: number; cwd?: string },
		ctx?: AgentToolContext,
	): Promise<{
		command: string;
		commandCwd: string;
		resolvedEnv: Record<string, string>;
		requestedTimeoutSec: number;
		timeoutSec: number;
		timeoutMs: number;
		notices: string[];
	}> {
		let command = input.command;
		let cwd = input.cwd;
		const env = normalizeBashEnv(input.env);

		if (this.session.settings.get("bash.stripTrailingHeadTail")) {
			const fixup = applyBashFixups(command);
			if (fixup.stripped.length > 0) {
				command = fixup.command;
			}
		}

		if (!cwd) {
			const cdMatch = command.match(/^cd[ \t]+((?:[^&\\\n\r]|\\.)+?)[ \t]*&&[ \t]*/);
			if (cdMatch) {
				cwd = cdMatch[1].trim().replace(/^["']|["']$/g, "");
				command = command.slice(cdMatch[0].length);
			}
		}

		const rawCommand = input.command;
		const allowedPrefixes = this.session.bashAllowedPrefixes;
		if (
			(this.session.bashRestrictionProfile === "read-only" || (allowedPrefixes && allowedPrefixes.length > 0)) &&
			env &&
			Object.keys(env).length > 0
		) {
			const mode = this.session.bashRestrictionProfile === "read-only" ? "Read-only" : "Restricted role-agent";
			throw new ToolError(`${mode} bash does not allow per-command env overrides.`);
		}
		if (allowedPrefixes && allowedPrefixes.length > 0) {
			const commandsToCheck = rawCommand === command ? [command] : [rawCommand, command];
			for (const commandToCheck of commandsToCheck) {
				const allowlist = checkBashAllowedPrefixes(commandToCheck, allowedPrefixes, {
					profile: this.session.bashRestrictionProfile,
				});
				if (!allowlist.allowed) {
					throw new ToolError(allowlist.reason ?? "Command blocked by restricted role-agent bash allowlist.");
				}
			}
		}
		if (this.session.bashRestrictionProfile === "read-only") {
			const normalizedReadOnlyCommand = normalizeReadOnlyBashCommand(command);
			if (!normalizedReadOnlyCommand) {
				throw new ToolError("Read-only bash command could not be normalized safely.");
			}
			command = normalizedReadOnlyCommand;
		}

		// Check both the original command and the cwd-normalized command so
		// leading `cd ... &&` wrappers do not hide either shell-navigation rules
		// or the dedicated-tool command that follows the directory change.
		if (this.session.bashRestrictionProfile !== "read-only" && this.session.settings.get("bashInterceptor.enabled")) {
			const rules = this.session.settings.getBashInterceptorRules();
			const commandsToCheck = rawCommand === command ? [command] : [rawCommand, command];
			for (const commandToCheck of commandsToCheck) {
				const interception = checkBashInterception(commandToCheck, ctx?.toolNames ?? [], rules);
				if (interception.block) {
					throw new ToolError(interception.message ?? "Command blocked");
				}
			}
		}

		const internalUrlOptions: InternalUrlExpansionOptions = {
			skills: this.session.skills ?? [],
			internalRouter: InternalUrlRouter.instance(),
			localOptions: {
				getArtifactsDir: this.session.getArtifactsDir,
				getSessionId: this.session.getSessionId,
			},
		};
		command = await expandInternalUrls(command, {
			...internalUrlOptions,
			ensureLocalParentDirs: this.session.bashRestrictionProfile !== "read-only",
		});
		const sessionFile = this.session.getSessionFile?.() ?? null;
		const expandedEnv = env
			? Object.fromEntries(
					await Promise.all(
						Object.entries(env).map(async ([key, value]) => [
							key,
							await expandInternalUrls(value, {
								...internalUrlOptions,
								ensureLocalParentDirs: true,
								noEscape: true,
							}),
						]),
					),
				)
			: undefined;
		const resolvedEnv = {
			...buildGjcRuntimeSessionEnv({
				sessionFile,
				sessionId: this.session.getSessionId?.(),
				cwd: this.session.cwd,
			}),
			...expandedEnv,
			...(this.session.bashRestrictionProfile === "read-only" ? READ_ONLY_BASH_ENV : {}),
			...(allowedPrefixes && allowedPrefixes.length > 0 ? { [GJC_RESTRICTED_ROLE_AGENT_BASH_ENV]: "1" } : {}),
		};

		if (cwd?.includes("://") || cwd?.includes("local:/")) {
			cwd = await expandInternalUrls(cwd, { ...internalUrlOptions, noEscape: true });
		}

		const commandCwd = cwd ? resolveToCwd(cwd, this.session.cwd) : this.session.cwd;
		let cwdStat: fs.Stats;
		try {
			cwdStat = await fs.promises.stat(commandCwd);
		} catch (err) {
			if (isEnoent(err)) {
				throw new ToolError(`Working directory does not exist: ${commandCwd}`);
			}
			throw err;
		}
		if (!cwdStat.isDirectory()) {
			throw new ToolError(`Working directory is not a directory: ${commandCwd}`);
		}

		const requestedTimeoutSec = input.timeout ?? 300;
		const timeoutSec = clampTimeout("bash", requestedTimeoutSec);
		const timeoutMs = timeoutSec * 1000;
		const notices: string[] = [];
		const timeoutClampNotice = formatTimeoutClampNotice(requestedTimeoutSec, timeoutSec);
		if (timeoutClampNotice) notices.push(timeoutClampNotice);

		return { command, commandCwd, resolvedEnv, requestedTimeoutSec, timeoutSec, timeoutMs, notices };
	}

	/**
	 * Start a background bash job for the Monitor tool. Reuses the full Bash
	 * pipeline (interceptors, internal-URL expansion, env, cwd, timeout); the
	 * public `monitor` tool itself is ACP-gated by `AgentSession` before this
	 * helper is called. The caller-supplied `onRawLine` callback is invoked once
	 * per newline-terminated stdout chunk, between turns, so the upstream Claude
	 * Code "Each stdout line is a task-notification event" semantics are preserved
	 * through the agent's existing background-task delivery path.
	 */
	async startMonitorJob(
		input: { command: string; cwd?: string; timeout?: number; env?: Record<string, string> },
		opts: {
			ownerId?: string;
			label?: string;
			ctx?: AgentToolContext;
			onRawLine?: (line: string, jobId: string) => void;
			shouldAcceptRawLine?: (jobId: string) => boolean;
			lifecycle?: import("../async").AsyncJobLifecycleCleanup;
		} = {},
	): Promise<{ jobId: string; label: string; commandCwd: string }> {
		const manager = AsyncJobManager.instance();
		if (!manager) {
			throw new ToolError("Async job manager unavailable for this session.");
		}
		const prepared = await this.#prepareBashExecution(input, opts.ctx);
		const label =
			opts.label ?? (prepared.command.length > 120 ? `${prepared.command.slice(0, 117)}...` : prepared.command);
		const monitorTimeoutMs = input.timeout === undefined ? null : prepared.timeoutMs;
		const onRawLine = opts.onRawLine;
		let currentJobId = "";
		let cursorOffset = 0;
		let lineBuffer = "";
		const dispatchLines = (chunk: string) => {
			if (opts.shouldAcceptRawLine?.(currentJobId) === false) return;
			if (!onRawLine) return;
			lineBuffer += chunk;
			let newlineIndex = lineBuffer.indexOf("\n");
			while (newlineIndex !== -1) {
				const line = lineBuffer.slice(0, newlineIndex);
				lineBuffer = lineBuffer.slice(newlineIndex + 1);
				if (opts.shouldAcceptRawLine?.(currentJobId) === false) return;
				try {
					onRawLine(line, currentJobId);
				} catch (error) {
					logger.warn("Monitor onRawLine callback failed", {
						error: error instanceof Error ? error.message : String(error),
					});
				}
				newlineIndex = lineBuffer.indexOf("\n");
			}
		};
		const flushTrailingLine = () => {
			if (!onRawLine) return;
			if (opts.shouldAcceptRawLine?.(currentJobId) === false) return;
			if (lineBuffer.length === 0) return;
			const remainder = lineBuffer;
			lineBuffer = "";
			try {
				onRawLine(remainder, currentJobId);
			} catch (error) {
				logger.warn("Monitor onRawLine callback failed (trailing)", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		};

		const ownerId = opts.ownerId ?? this.session.getAgentId?.() ?? undefined;
		const jobId = manager.register(
			"bash",
			label,
			async ({ jobId: id, signal, reportProgress }) => {
				const { path: artifactPath, id: artifactId } = (await this.session.allocateOutputArtifact?.("bash")) ?? {};
				const tailBuffer = new TailBuffer(DEFAULT_MAX_BYTES);
				try {
					const result = await executeBash(prepared.command, {
						cwd: prepared.commandCwd,
						sessionKey: `${this.session.getSessionId?.() ?? ""}:monitor:${id}`,
						timeout: monitorTimeoutMs,
						signal,
						env: prepared.resolvedEnv,
						artifactPath,
						artifactId,
						oneShot: true,
						ignoreShellPrefix: this.session.bashRestrictionProfile === "read-only",
						disableShellSnapshot: this.session.bashRestrictionProfile === "read-only",
						onChunk: chunk => {
							tailBuffer.append(chunk);
							void reportProgress(tailBuffer.text(), {
								async: { state: "running", jobId: id, type: "bash" },
							});
						},
						onRawChunk: chunk => {
							manager.appendOutput(id, chunk);
							const slice = manager.readOutputSince(id, cursorOffset, ownerId ? { ownerId } : undefined);
							if (!slice) return;
							cursorOffset = slice.nextOffset;
							dispatchLines(slice.text);
						},
						onMinimizedSave: originalText => saveBashOriginalArtifactForTests(this.session, originalText),
					});
					flushTrailingLine();
					this.#buildResultText(result, prepared.timeoutSec, result.output || "(no output)");
					return result.output;
				} catch (error) {
					flushTrailingLine();
					throw error instanceof Error ? error : new Error(String(error));
				}
			},
			{ ownerId, metadata: { monitor: true }, lifecycle: opts.lifecycle },
		);
		currentJobId = jobId;
		return { jobId, label, commandCwd: prepared.commandCwd };
	}

	async execute(
		_toolCallId: string,
		{
			command: rawCommand,
			env: rawEnv,
			timeout: rawTimeout = 300,
			cwd,

			async: asyncRequested = false,
			pty = false,
		}: BashToolInput,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<BashToolDetails>,
		ctx?: AgentToolContext,
	): Promise<AgentToolResult<BashToolDetails>> {
		if (asyncRequested && !this.#asyncEnabled) {
			throw new ToolError("Async bash execution is disabled. Enable async.enabled to use async mode.");
		}
		if (this.session.bashRestrictionProfile === "read-only" && pty) {
			throw new ToolError("Read-only bash does not allow PTY mode.");
		}

		const prepared = await this.#prepareBashExecution(
			{ command: rawCommand, env: rawEnv, timeout: rawTimeout, cwd },
			ctx,
		);
		const {
			command,
			commandCwd,
			resolvedEnv,
			requestedTimeoutSec,
			timeoutSec,
			timeoutMs,
			notices: pendingNotices,
		} = prepared;

		if (asyncRequested) {
			if (!AsyncJobManager.instance()) {
				throw new ToolError("Async job manager unavailable for this session.");
			}
			const job = this.#startManagedBashJob({
				command,
				commandCwd,
				timeoutMs,
				timeoutSec,
				requestedTimeoutSec,
				notices: pendingNotices,

				resolvedEnv,
				onUpdate,
				startBackgrounded: true,
			});
			return this.#buildBackgroundStartResult(job.jobId, job.label, "", timeoutSec, {
				requestedTimeoutSec,
				notices: pendingNotices,
			});
		}

		const autoBgManager = AsyncJobManager.instance();
		if (this.#autoBackgroundEnabled && !pty && autoBgManager) {
			const autoBackgroundWaitMs = this.#resolveAutoBackgroundWaitMs(timeoutMs);
			const startBackgrounded = autoBackgroundWaitMs === 0;
			const job = this.#startManagedBashJob({
				command,
				commandCwd,
				timeoutMs,
				timeoutSec,
				requestedTimeoutSec,
				notices: pendingNotices,

				resolvedEnv,
				onUpdate,
				startBackgrounded,
			});
			if (startBackgrounded) {
				return this.#buildBackgroundStartResult(job.jobId, job.label, "", timeoutSec, {
					requestedTimeoutSec,
					notices: pendingNotices,
				});
			}
			const waitResult = await this.#waitForManagedBashJob(job, autoBackgroundWaitMs, signal);
			if (waitResult.kind === "completed") {
				autoBgManager.acknowledgeDeliveries([job.jobId]);
				return waitResult.result;
			}
			if (waitResult.kind === "failed") {
				autoBgManager.acknowledgeDeliveries([job.jobId]);
				throw waitResult.error;
			}
			if (waitResult.kind === "aborted") {
				autoBgManager.cancel(job.jobId);
				autoBgManager.acknowledgeDeliveries([job.jobId]);
				throw new ToolAbortError(job.getLatestText() || "Command aborted");
			}
			job.setBackgrounded(true);
			return this.#buildBackgroundStartResult(job.jobId, job.label, job.getLatestText(), timeoutSec, {
				requestedTimeoutSec,
				notices: pendingNotices,
			});
		}

		// Route through the client terminal when the client advertises the terminal capability.
		// Skip when pty=true (PTY needs the local terminal UI).
		const clientBridge =
			this.session.bashRestrictionProfile === "read-only" ? undefined : this.session.getClientBridge?.();
		if (clientBridge?.capabilities.terminal && clientBridge.createTerminal && !pty) {
			const handle = await clientBridge.createTerminal({
				command,
				cwd: commandCwd,
				env: resolvedEnv
					? Object.entries(resolvedEnv).map(([name, value]) => ({ name, value: value as string }))
					: undefined,
				outputByteLimit: DEFAULT_MAX_BYTES,
			});

			// Emit partial update so the editor can embed the live terminal card.
			onUpdate?.({ content: [], details: { terminalId: handle.terminalId } });

			const exitPromise = handle.waitForExit();
			let exitStatus!: ClientBridgeTerminalExitStatus;

			type BridgeRaceResult =
				| { kind: "exit"; status: ClientBridgeTerminalExitStatus }
				| { kind: "poll" }
				| { kind: "timeout" }
				| { kind: "aborted" };

			// Set up abort listener before entering the poll loop. The listener
			// kicks off `handle.kill()` synchronously so a `session/cancel`
			// arriving mid-poll terminates the remote command immediately,
			// instead of waiting for the next `currentOutput()` to return.
			const { promise: abortedP, resolve: resolveAborted } = Promise.withResolvers<void>();
			let killStarted = false;
			const fireKill = (): Promise<void> => {
				if (killStarted) return Promise.resolve();
				killStarted = true;
				return handle.kill().catch((error: unknown) => {
					logger.warn("ACP terminal kill failed", { terminalId: handle.terminalId, error });
				});
			};
			const onAbortSignal = () => {
				resolveAborted();
				void fireKill();
			};
			signal?.addEventListener("abort", onAbortSignal, { once: true });

			try {
				try {
					if (signal?.aborted) {
						await fireKill();
						throw new ToolAbortError("Command aborted");
					}

					const timeoutPromise = Bun.sleep(timeoutMs).then(() => ({ kind: "timeout" as const }));
					// Poll until the process exits, times out, or the caller aborts.
					for (;;) {
						const racers: Array<Promise<BridgeRaceResult>> = [
							exitPromise.then(s => ({ kind: "exit" as const, status: s })),
							timeoutPromise,
							Bun.sleep(250).then(() => ({ kind: "poll" as const })),
						];
						if (signal) {
							racers.push(abortedP.then(() => ({ kind: "aborted" as const })));
						}
						const raced = await Promise.race(racers);

						if (raced.kind === "aborted" || signal?.aborted) {
							await fireKill();
							throw new ToolAbortError("Command aborted");
						}

						if (raced.kind === "timeout") {
							// Kill before reading final output so a slow `terminal/output`
							// RPC cannot let a timed-out command keep running past the
							// enforced timeout. The handle stays valid post-kill so the
							// buffered output is still readable.
							await fireKill();
							let current = { output: "", truncated: false };
							try {
								current = await handle.currentOutput();
							} catch (error) {
								logger.warn("ACP terminal final output read failed", {
									terminalId: handle.terminalId,
									error,
								});
							}
							const timedOutResult: BashInteractiveResult = {
								output: current.output,
								exitCode: undefined,
								cancelled: false,
								timedOut: true,
								truncated: current.truncated,
								totalLines: current.output.length > 0 ? current.output.split("\n").length : 0,
								totalBytes: current.output.length,
								outputLines: current.output.length > 0 ? current.output.split("\n").length : 0,
								outputBytes: current.output.length,
							};
							return this.#buildCompletedResult(timedOutResult, timeoutSec, {
								requestedTimeoutSec,
								notices: pendingNotices,
								terminalId: handle.terminalId,
							});
						}

						if (raced.kind === "exit") {
							exitStatus = raced.status;
							break;
						}

						// Poll tick: push current output so agent-loop transcript stays consistent.
						// Race the read against abort so a stuck `terminal/output` RPC does not
						// delay cancellation.
						const pollOutput = await Promise.race([
							handle.currentOutput(),
							abortedP.then(() => undefined as ClientBridgeTerminalOutput | undefined),
						]);
						if (pollOutput === undefined) {
							// Abort fired during the poll-tick read; let the next loop iteration
							// observe `signal?.aborted` and exit via the abort branch.
							continue;
						}
						onUpdate?.({
							content: [{ type: "text", text: pollOutput.output }],
							details: { terminalId: handle.terminalId },
						});
					}
				} finally {
					signal?.removeEventListener("abort", onAbortSignal);
				}

				// Fetch final output; the terminal is released in the outer finally.
				const finalOutput = await handle.currentOutput();

				// Map exit status: null exitCode with a signal → treat as signal kill (137).
				const rawExitCode = exitStatus.exitCode;
				const exitCode: number | undefined =
					rawExitCode != null ? rawExitCode : exitStatus.signal ? 137 : undefined;

				const outputText = finalOutput.output;
				const outputByteLen = outputText.length;
				const outputLineCount = outputText.length > 0 ? outputText.split("\n").length : 0;

				const bridgeResult: BashResult = {
					output: outputText,
					exitCode,
					cancelled: false,
					truncated: finalOutput.truncated,
					totalLines: outputLineCount,
					totalBytes: outputByteLen,
					outputLines: outputLineCount,
					outputBytes: outputByteLen,
				};

				const bridgeNotices: string[] = [];
				if (finalOutput.truncated) bridgeNotices.push("(output truncated)");
				for (const notice of pendingNotices) bridgeNotices.push(notice);

				return this.#buildCompletedResult(bridgeResult, timeoutSec, {
					requestedTimeoutSec,
					notices: bridgeNotices,
					terminalId: handle.terminalId,
				});
			} finally {
				try {
					await handle.release();
				} catch (error) {
					logger.warn("ACP terminal release failed", { terminalId: handle.terminalId, error });
				}
			}
		}

		// Track output for streaming updates (tail only)
		const tailBuffer = new TailBuffer(DEFAULT_MAX_BYTES);

		// Allocate artifact for truncated output storage
		const { path: artifactPath, id: artifactId } = (await this.session.allocateOutputArtifact?.("bash")) ?? {};

		const interactiveUi =
			this.session.bashRestrictionProfile === "read-only"
				? undefined
				: canUseInteractiveBashPty(pty, ctx)
					? ctx?.ui
					: undefined;
		const result: BashResult | BashInteractiveResult = interactiveUi
			? await runInteractiveBashPty(interactiveUi, {
					command,
					cwd: commandCwd,
					timeoutMs,
					signal,
					env: resolvedEnv,
					artifactPath,
					artifactId,
				})
			: await executeBash(command, {
					cwd: commandCwd,
					sessionKey: this.session.getSessionId?.() ?? undefined,
					oneShot: this.session.bashRestrictionProfile === "read-only",
					timeout: timeoutMs,
					signal,
					env: resolvedEnv,
					artifactPath,
					artifactId,
					onChunk: streamTailUpdates(tailBuffer, onUpdate),
					onMinimizedSave: originalText => saveBashOriginalArtifactForTests(this.session, originalText),
					ignoreShellPrefix: this.session.bashRestrictionProfile === "read-only",
					disableShellSnapshot: this.session.bashRestrictionProfile === "read-only",
				});
		if (result.cancelled) {
			if (signal?.aborted) {
				throw new ToolAbortError(normalizeResultOutput(result) || "Command aborted");
			}
			throw new ToolError(normalizeResultOutput(result) || "Command aborted");
		}
		if (isInteractiveResult(result) && result.timedOut) {
			throw new ToolError(normalizeResultOutput(result) || `Command timed out after ${timeoutSec} seconds`);
		}
		return this.#buildCompletedResult(result, timeoutSec, {
			requestedTimeoutSec,
			notices: pendingNotices,
		});
	}
}

// =============================================================================
// TUI Renderer
// =============================================================================
export interface BashRenderArgs {
	command?: string;
	env?: Record<string, string>;
	timeout?: number;
	cwd?: string;
	__partialJson?: string;
	[key: string]: unknown;
}

export interface BashRenderContext {
	/** Raw output text */
	output?: string;
	/** Whether output came from artifact storage */
	isFullOutput?: boolean;
	/** Whether output is expanded */
	expanded?: boolean;
	/** Number of preview lines when collapsed */
	previewLines?: number;
	/** Timeout in seconds */
	timeout?: number;
}

export interface ShellRendererConfig<TArgs> {
	resolveTitle: (args: TArgs | undefined, options: RenderResultOptions) => string;
	resolveCommand?: (args: TArgs | undefined) => string | undefined;
	resolveCwd?: (args: TArgs | undefined) => string | undefined;
	resolveEnv?: (args: TArgs | undefined) => Record<string, string> | undefined;
}

function getPartialJson<TArgs>(args: TArgs | undefined): string | undefined {
	if (!args || typeof args !== "object" || !("__partialJson" in args)) return undefined;
	const value = (args as { __partialJson?: unknown }).__partialJson;
	return typeof value === "string" ? value : undefined;
}

export function getBashEnvForDisplay(args: BashRenderArgs): Record<string, string> | undefined {
	// During streaming, partial-json parsing often does not surface env values until the object closes.
	// Recover them from the raw JSON buffer so the pending bash preview can show `NAME="..." cmd` immediately,
	// instead of rendering only the command and making the env assignment appear at the very end.
	const partialEnv = extractPartialBashEnv(args.__partialJson);
	if (partialEnv && args.env) return { ...partialEnv, ...args.env };
	return args.env ?? partialEnv;
}

export function formatBashCommand(args: BashRenderArgs): string {
	const command = replaceTabs(args.command || "…");
	const prompt = "$";
	const cwd = getProjectDir();
	const displayWorkdir = formatToolWorkingDirectory(args.cwd, cwd);
	const renderedCommand = [formatBashEnvAssignments(getBashEnvForDisplay(args)), command].filter(Boolean).join(" ");
	return displayWorkdir ? `${prompt} cd ${displayWorkdir} && ${renderedCommand}` : `${prompt} ${renderedCommand}`;
}

/**
 * Returns the bash command formatted for the result body: the dim `$ cd … &&`
 * prefix joined with syntax-highlighted command lines. The prefix is applied
 * only to the first line so multi-line commands display cleanly — terminals
 * reset SGR state at line boundaries, which made the previous single-string
 * `theme.fg("dim", ...)` form render only the first line as dim.
 */
export function formatBashCommandLines(args: BashRenderArgs, uiTheme: Theme): string[] {
	const command = replaceTabs(args.command || "…");
	const cwd = getProjectDir();
	const displayWorkdir = formatToolWorkingDirectory(args.cwd, cwd);
	const envAssignments = formatBashEnvAssignments(getBashEnvForDisplay(args));
	const prefixParts = ["$"];
	if (displayWorkdir) prefixParts.push(`cd ${displayWorkdir} &&`);
	if (envAssignments) prefixParts.push(envAssignments);
	const prefix = uiTheme.fg("dim", `${prefixParts.join(" ")} `);
	const highlightedLines = highlightCode(command, "bash");
	if (highlightedLines.length === 0) return [prefix.trimEnd()];
	return highlightedLines.map((line, i) => (i === 0 ? `${prefix}${line}` : line));
}

function toBashRenderArgs<TArgs>(args: TArgs | undefined, config: ShellRendererConfig<TArgs>): BashRenderArgs {
	return {
		command: config.resolveCommand?.(args),
		cwd: config.resolveCwd?.(args),
		env: config.resolveEnv?.(args),
		__partialJson: getPartialJson(args),
	};
}

export function createShellRenderer<TArgs>(config: ShellRendererConfig<TArgs>) {
	return {
		renderCall(args: TArgs, options: RenderResultOptions, uiTheme: Theme): Component {
			const renderArgs = toBashRenderArgs(args, config);
			const cmdText = formatBashCommand(renderArgs);
			const title = config.resolveTitle(args, options);
			const text = renderStatusLine({ icon: "pending", title, description: cmdText }, uiTheme);
			return new Text(text, 0, 0);
		},

		renderResult(
			result: {
				content: Array<{ type: string; text?: string }>;
				details?: BashToolDetails;
				isError?: boolean;
			},
			options: RenderResultOptions & { renderContext?: BashRenderContext },
			uiTheme: Theme,
			args?: TArgs,
		): Component {
			const renderArgs = toBashRenderArgs(args, config);
			const cmdLines = args ? formatBashCommandLines(renderArgs, uiTheme) : undefined;
			const isError = result.isError === true;
			const icon = options.isPartial ? "pending" : isError ? "error" : "success";
			const title = config.resolveTitle(args, options);
			const header = renderStatusLine({ icon, title }, uiTheme);
			const details = result.details;
			const outputBlock = new CachedOutputBlock();

			return {
				render: (width: number): string[] => {
					// REACTIVE: read mutable options at render time
					const { renderContext } = options;
					const expanded = renderContext?.expanded ?? options.expanded;
					const previewLines = renderContext?.previewLines ?? BASH_DEFAULT_PREVIEW_LINES;

					// Get output from context (preferred) or fall back to result content.
					// Strip the LLM-facing notice appended by wrappedExecute so we don't
					// double-print it alongside the styled warning line below.
					const rawOutput = renderContext?.output ?? result.content?.find(c => c.type === "text")?.text ?? "";
					const output = stripOutputNotice(rawOutput, details?.meta);
					const displayOutput = output.trimEnd();
					const showingFullOutput = expanded && renderContext?.isFullOutput === true;

					// Build truncation warning
					const timeoutSeconds = details?.timeoutSeconds ?? renderContext?.timeout;
					const requestedTimeoutSeconds = details?.requestedTimeoutSeconds;
					const timeoutLabel =
						typeof timeoutSeconds === "number"
							? requestedTimeoutSeconds !== undefined && requestedTimeoutSeconds !== timeoutSeconds
								? `Timeout: ${timeoutSeconds}s (requested ${requestedTimeoutSeconds}s clamped)`
								: `Timeout: ${timeoutSeconds}s`
							: undefined;
					const timeoutLine =
						timeoutLabel !== undefined
							? uiTheme.fg("dim", `${uiTheme.format.bracketLeft}${timeoutLabel}${uiTheme.format.bracketRight}`)
							: undefined;
					let warningLine: string | undefined;
					if (details?.meta?.truncation && !showingFullOutput) {
						warningLine = formatStyledTruncationWarning(details.meta, uiTheme) ?? undefined;
					}

					const outputLines: string[] = [];
					const hasOutput = displayOutput.trim().length > 0;
					const rawOutputLines = displayOutput.split("\n");
					const sixelLineMask =
						TERMINAL.imageProtocol === ImageProtocol.Sixel ? getSixelLineMask(rawOutputLines) : undefined;
					const hasSixelOutput = sixelLineMask?.some(Boolean) ?? false;
					if (hasOutput) {
						if (hasSixelOutput) {
							outputLines.push(
								...rawOutputLines.map((line, index) =>
									sixelLineMask?.[index] ? line : uiTheme.fg("toolOutput", replaceTabs(line)),
								),
							);
						} else if (expanded) {
							outputLines.push(...rawOutputLines.map(line => uiTheme.fg("toolOutput", replaceTabs(line))));
						} else {
							const styledOutput = rawOutputLines
								.map(line => uiTheme.fg("toolOutput", replaceTabs(line)))
								.join("\n");
							const textContent = styledOutput;
							const result = truncateToVisualLines(textContent, previewLines, width);
							if (result.skippedCount > 0) {
								outputLines.push(
									uiTheme.fg(
										"dim",
										`… (${result.skippedCount} earlier lines, showing ${result.visualLines.length} of ${result.skippedCount + result.visualLines.length}) (ctrl+o to expand)`,
									),
								);
							}
							outputLines.push(...result.visualLines);
						}
					}
					if (timeoutLine) outputLines.push(timeoutLine);
					if (warningLine) outputLines.push(warningLine);

					return outputBlock.render(
						{
							header,
							state: options.isPartial ? "pending" : isError ? "error" : "success",
							sections: [
								{ lines: cmdLines ?? [] },
								{ label: uiTheme.fg("toolTitle", "Output"), lines: outputLines },
							],
							width,
						},
						uiTheme,
					);
				},
				invalidate: () => {
					outputBlock.invalidate();
				},
			};
		},
		mergeCallAndResult: true,
		inline: true,
	};
}

export const bashToolRenderer = createShellRenderer<BashRenderArgs>({
	resolveTitle: () => "Bash",
	resolveCommand: args => args?.command,
	resolveCwd: args => args?.cwd,
	resolveEnv: args => args?.env,
});
