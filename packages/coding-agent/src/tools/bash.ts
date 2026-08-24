import * as fs from "node:fs";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@gajae-code/agent-core";
import type { Component } from "@gajae-code/tui";
import { getKeybindings, ImageProtocol, TERMINAL, Text, visibleWidth } from "@gajae-code/tui";
import { getProjectDir, isEnoent, logger, prompt } from "@gajae-code/utils";
import * as z from "zod/v4";
import { AsyncJobManager } from "../async";
import { type BashArtifactSaveResult, type BashResult, executeBash } from "../exec/bash-executor";

import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { buildGjcRuntimeSessionEnv } from "../gjc-runtime/goal-mode-request";
import {
	GJC_RALPLAN_ARTIFACT_ENV,
	GJC_RESTRICTED_ROLE_AGENT_BASH_ENV,
} from "../gjc-runtime/restricted-role-agent-bash";
import { InternalUrlRouter } from "../internal-urls";
import { truncateToVisualLines } from "../modes/components/visual-truncate";
import { highlightCode, type Theme } from "../modes/theme/theme";
import bashDescription from "../prompts/tools/bash.md" with { type: "text" };
import type { ArtifactManager } from "../session/artifacts";
import type { ClientBridgeTerminalExitStatus, ClientBridgeTerminalOutput } from "../session/client-bridge";
import {
	DEFAULT_ARTIFACT_MAX_BYTES,
	OutputSink,
	type OutputSummary,
	streamTailUpdates,
	TailBuffer,
	type TerminalArtifactPublisher,
	type TerminalArtifactPublishResult,
	truncateHeadBytes,
	truncateTailBytes,
} from "../session/streaming-output";
import {
	lookupOwnedRegistration,
	registerOwnedIfLineaged,
	unregisterOwnedRegistration,
} from "../session/terminal-abort";

import { renderStatusLine } from "../tui";
import { CachedOutputBlock, getOutputBlockContentWidth } from "../tui/output-block";
import { truncateToWidth } from "../tui/utils";
import { getSixelLineMask } from "../utils/sixel";
import type { ToolSession } from ".";
import { checkBashAllowedPrefixes, normalizeReadOnlyBashCommand } from "./bash-allowed-prefixes";
import { applyBashFixups } from "./bash-command-fixup";
import { type BashInteractiveResult, runInteractiveBashPty } from "./bash-interactive";
import { checkBashInterception } from "./bash-interceptor";
import { canUseInteractiveBashPty } from "./bash-pty-selection";
import { expandInternalUrls, type InternalUrlExpansionOptions } from "./bash-skill-urls";
import { longSleepAdvisory } from "./bash-sleep-advisory";
import { checkComposerBashPolicy } from "./composer-bash-policy";
import {
	formatArtifactReference,
	formatStyledTruncationWarning,
	type OutputMeta,
	resolveBashOutputSinkHeadBytes,
	resolveBashOutputSinkTailBytes,
	stripOutputNotice,
} from "./output-meta";
import { resolveToCwd } from "./path-utils";
import { formatToolWorkingDirectory, replaceTabs } from "./render-utils";
import { checkTmuxSelfInjection } from "./tmux-self-injection-guard";
import { ToolAbortError, ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";
import { clampTimeout, TOOL_TIMEOUTS } from "./tool-timeouts";

export const BASH_DEFAULT_PREVIEW_LINES = 10;

const BASH_ERROR_MAX_BYTES = 4096;
const ARTIFACT_SAVE_DIAGNOSTIC_MAX_BYTES = 256;
const BASH_ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DEFAULT_AUTO_BACKGROUND_THRESHOLD_MS = 60_000;
const READ_ONLY_BASH_ENV: Record<string, string> = {
	GREP_OPTIONS: "",
	GREP_COLOR: "",
	GREP_COLORS: "",
	RIPGREP_CONFIG_PATH: "",
};

export type BashOriginalArtifactSaveResult = BashArtifactSaveResult;

function boundArtifactSaveDiagnostic(error: unknown): string {
	const message = (error instanceof Error ? error.message : String(error)).replace(/\s+/gu, " ").trim();
	const normalized = message || "unknown storage error";
	return truncateHeadBytes(normalized, ARTIFACT_SAVE_DIAGNOSTIC_MAX_BYTES).text;
}

function summarizeOriginalArtifactSave(
	artifactId: string,
	originalText: string,
): Extract<BashOriginalArtifactSaveResult, { status: "saved" }> {
	const originalBytes = Buffer.byteLength(originalText, "utf-8");
	if (originalBytes <= DEFAULT_ARTIFACT_MAX_BYTES) {
		return { status: "saved", artifactId, complete: true };
	}
	const retainedBytes = truncateHeadBytes(originalText, DEFAULT_ARTIFACT_MAX_BYTES).bytes;
	return {
		status: "saved",
		artifactId,
		complete: false,
		omittedBytes: originalBytes - retainedBytes,
	};
}

function artifactSaveResultNotice(
	result: BashOriginalArtifactSaveResult,
	hasAlternateCompleteArtifact = false,
): string | undefined {
	if (result.status === "failed") return `Bash output artifact save failed: ${result.diagnostic}`;
	if (result.status === "unavailable" && !hasAlternateCompleteArtifact) {
		return "Bash output artifact unavailable: full original output could not be stored because artifact storage is unavailable.";
	}
	return undefined;
}

function artifactTruncatedBytesForResult(result: BashResult | BashInteractiveResult): number | undefined {
	const bytes = (result as OutputSummary).artifactTruncatedBytes;
	return typeof bytes === "number" && bytes > 0 ? bytes : undefined;
}

function artifactReferenceForResult(result: BashResult | BashInteractiveResult): string | undefined {
	return result.artifactId
		? formatArtifactReference(result.artifactId, artifactTruncatedBytesForResult(result))
		: undefined;
}

function rawArtifactReferenceForSavedResult(
	result: Extract<BashOriginalArtifactSaveResult, { status: "saved" }>,
): string {
	return result.complete
		? `artifact://${result.artifactId}`
		: formatArtifactReference(result.artifactId, result.omittedBytes);
}

function appendRawArtifactFooter(
	summary: OutputSummary,
	result: Extract<BashOriginalArtifactSaveResult, { status: "saved" }>,
): void {
	summary.artifactId = result.artifactId;
	if (!result.complete) summary.artifactTruncatedBytes = result.omittedBytes;
	const separator = summary.output.endsWith("\n") ? "" : "\n";
	summary.output = `${summary.output}${separator}[raw output: ${rawArtifactReferenceForSavedResult(result)}]`;
}

function artifactReferenceIsReachable(text: string, result: BashResult | BashInteractiveResult): boolean {
	if (!result.artifactId || !text.includes(`artifact://${result.artifactId}`)) return false;
	const artifactTruncatedBytes = artifactTruncatedBytesForResult(result);
	return (
		artifactTruncatedBytes === undefined ||
		text.includes(formatArtifactReference(result.artifactId, artifactTruncatedBytes))
	);
}

function artifactFailureDiagnosticForResult(result: BashResult | BashInteractiveResult): string | undefined {
	const diagnostic = (result as OutputSummary).artifactFailureDiagnostic;
	return typeof diagnostic === "string" && diagnostic.length > 0 ? diagnostic : undefined;
}

function artifactWriterFailureNotice(result: BashResult | BashInteractiveResult): string | undefined {
	const diagnostic = artifactFailureDiagnosticForResult(result);
	if (!diagnostic) return undefined;
	if (diagnostic.startsWith("unavailable:")) {
		return `Bash output artifact unavailable: ${diagnostic.slice("unavailable:".length).trim()}`;
	}
	const normalized = diagnostic.startsWith("failed:") ? diagnostic.slice("failed:".length).trim() : diagnostic;
	return `Bash output artifact writer failed: ${normalized}`;
}

function completeOutputArtifactAvailable(
	result: Pick<OutputSummary, "artifactId" | "artifactTruncatedBytes" | "artifactFailureDiagnostic">,
): boolean {
	return (
		result.artifactId !== undefined &&
		(typeof result.artifactTruncatedBytes !== "number" || result.artifactTruncatedBytes <= 0) &&
		(typeof result.artifactFailureDiagnostic !== "string" || result.artifactFailureDiagnostic.length === 0)
	);
}

function failureStatusCause(
	result: BashResult | BashInteractiveResult,
	text: string,
	explicitCause?: string,
): string | undefined {
	if (explicitCause) return explicitCause;
	const leadingStatus = /^\[(Command (?:timed out(?: after \d+ seconds?)?|cancelled))\]/u.exec(text)?.[1];
	const statusMatches = Array.from(text.matchAll(/Command (?:timed out(?: after \d+ seconds?)?|cancelled|aborted)/gu));
	const lastStatus = statusMatches[statusMatches.length - 1]?.[0];
	if (result.cancelled) return leadingStatus ?? lastStatus ?? "Command cancelled";
	if (isInteractiveResult(result) && result.timedOut) return lastStatus ?? "Command timed out";
	if (result.exitCode === undefined) return "Command failed: missing exit status";
	if (result.exitCode !== 0) return `Command exited with code ${result.exitCode}`;
	return undefined;
}

function removeTrailingFailureCause(text: string, cause: string | undefined): string {
	if (!cause) return text;
	for (const suffix of [`\n\n${cause}`, `\n${cause}`, cause]) {
		if (text.endsWith(suffix)) return text.slice(0, -suffix.length);
	}
	return text;
}

function formatBashFailureMessage(
	result: BashResult | BashInteractiveResult,
	text: string,
	explicitCause?: string,
): string {
	const statusCause = failureStatusCause(result, text, explicitCause);
	const bodyText = removeTrailingFailureCause(text, statusCause);
	const suffixParts: string[] = [];
	const reference = artifactReferenceForResult(result);
	if (reference && !artifactReferenceIsReachable(text, result)) suffixParts.push(reference);
	const writerNotice = artifactWriterFailureNotice(result);
	if (writerNotice) suffixParts.push(writerNotice);
	if (statusCause) suffixParts.push(statusCause);
	const suffix = suffixParts.join("\n\n");
	const separator = bodyText.length > 0 && suffix.length > 0 ? "\n\n" : "";
	const bodyBudget = Math.max(
		0,
		BASH_ERROR_MAX_BYTES - Buffer.byteLength(suffix, "utf-8") - Buffer.byteLength(separator, "utf-8"),
	);
	const body = truncateTailBytes(bodyText, bodyBudget).text;
	return `${body}${body.length > 0 ? separator : ""}${suffix}`;
}

async function boundClientTerminalOutput(
	output: string,
	alreadyTruncated: boolean,
	settings: ToolSession["settings"],
): Promise<{ summary: OutputSummary; locallyTruncated: boolean }> {
	const tailBytes = resolveBashOutputSinkTailBytes(settings);
	const headBytes = resolveBashOutputSinkHeadBytes(settings);
	const sink = new OutputSink({ spillThreshold: tailBytes, headBytes });
	sink.push(output);
	const bounded = await sink.dump();
	return {
		summary: {
			...bounded,
			truncated: alreadyTruncated || bounded.truncated,
		},
		locallyTruncated: bounded.truncated,
	};
}

interface PreparedClientTerminalOutput {
	current: ClientBridgeTerminalOutput;
	summary: OutputSummary;
	locallyTruncated: boolean;
	artifactSaveResult?: BashOriginalArtifactSaveResult;
	artifactSaveNotice?: string;
}

async function prepareClientTerminalOutput(
	session: ToolSession,
	current: ClientBridgeTerminalOutput,
): Promise<PreparedClientTerminalOutput> {
	const { summary, locallyTruncated } = await boundClientTerminalOutput(
		current.output,
		current.truncated,
		session.settings,
	);
	let artifactSaveResult: BashOriginalArtifactSaveResult | undefined;
	if (locallyTruncated && !current.truncated) {
		artifactSaveResult = await saveBashOriginalArtifact(session, current.output);
		if (artifactSaveResult.status === "saved") appendRawArtifactFooter(summary, artifactSaveResult);
	}
	const artifactSaveNotice = artifactSaveResult
		? artifactSaveResultNotice(artifactSaveResult, completeOutputArtifactAvailable(summary))
		: undefined;
	return { current, summary, locallyTruncated, artifactSaveResult, artifactSaveNotice };
}

function formatClientTerminalAbortFailure(
	prepared: PreparedClientTerminalOutput,
	readDiagnostic?: string,
	pendingNotices: readonly string[] = [],
): string {
	const notices = [
		...pendingNotices,
		...(prepared.current.truncated || prepared.locallyTruncated ? ["(output truncated)"] : []),
		...(prepared.artifactSaveNotice ? [prepared.artifactSaveNotice] : []),
		...(readDiagnostic ? [`Terminal output recovery failed: ${readDiagnostic}`] : []),
	];
	const outputLines = [prepared.summary.output || "(no output)", ...notices].filter(Boolean);
	const outputText = outputLines.join("\n");
	const result: BashResult = {
		...prepared.summary,
		exitCode: undefined,
		cancelled: true,
	};
	return formatBashFailureMessage(result, outputText, "Command aborted");
}

function appendArtifactDetails(text: string, result: BashResult | BashInteractiveResult): string {
	const suffixParts: string[] = [];
	const reference = artifactReferenceForResult(result);
	if (reference && !artifactReferenceIsReachable(text, result)) suffixParts.push(reference);
	const writerNotice = artifactWriterFailureNotice(result);
	if (writerNotice && !text.includes(writerNotice)) suffixParts.push(writerNotice);
	return suffixParts.length > 0 ? `${text}${text.endsWith("\n") ? "" : "\n"}${suffixParts.join("\n\n")}` : text;
}

async function saveBashOriginalArtifact(
	session: ToolSession,
	originalText: string,
): Promise<BashOriginalArtifactSaveResult> {
	let manager: ArtifactManager | null | undefined;
	try {
		manager = session.getArtifactManager?.();
	} catch (error) {
		return { status: "failed", diagnostic: boundArtifactSaveDiagnostic(error) };
	}
	if (manager) {
		try {
			const artifactId = await manager.save(originalText, "bash-original");
			return artifactId
				? summarizeOriginalArtifactSave(artifactId, originalText)
				: { status: "failed", diagnostic: "storage returned no artifact id" };
		} catch (error) {
			return { status: "failed", diagnostic: boundArtifactSaveDiagnostic(error) };
		}
	}

	if (!session.allocateOutputArtifact) return { status: "unavailable" };
	let alloc: { id?: string; path?: string } | undefined;
	try {
		alloc = await session.allocateOutputArtifact("bash-original");
	} catch (error) {
		return { status: "failed", diagnostic: boundArtifactSaveDiagnostic(error) };
	}
	if (!alloc?.path || !alloc.id) return { status: "unavailable" };
	try {
		const saveResult = summarizeOriginalArtifactSave(alloc.id, originalText);
		const payload = saveResult.complete
			? originalText
			: (() => {
					const retained = truncateHeadBytes(originalText, DEFAULT_ARTIFACT_MAX_BYTES);
					return `${retained.text}\n[artifact truncated after ${retained.bytes} bytes; omitted at least ${saveResult.omittedBytes} bytes]\n`;
				})();
		await Bun.write(alloc.path, payload);
		return saveResult;
	} catch (error) {
		return { status: "failed", diagnostic: boundArtifactSaveDiagnostic(error) };
	}
}

function createBashArtifactPublisher(session: ToolSession): TerminalArtifactPublisher {
	return async (content, _info): Promise<TerminalArtifactPublishResult> => {
		let manager: ArtifactManager | null | undefined;
		try {
			manager = session.getArtifactManager?.();
		} catch (error) {
			return { status: "failed", diagnostic: boundArtifactSaveDiagnostic(error) };
		}
		if (!manager) return { status: "unavailable" };
		try {
			const artifactId = await manager.save(content, "bash");
			return artifactId
				? { status: "published", artifactId }
				: { status: "failed", diagnostic: "storage returned no artifact id" };
		} catch (error) {
			return { status: "failed", diagnostic: boundArtifactSaveDiagnostic(error) };
		}
	};
}

export async function saveBashOriginalArtifactForTests(
	session: ToolSession,
	originalText: string,
	onResult?: (result: BashOriginalArtifactSaveResult) => void,
): Promise<string | undefined> {
	const result = await saveBashOriginalArtifact(session, originalText);
	onResult?.(result);
	return result.status === "saved" ? result.artifactId : undefined;
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

/** Project only a bare executable name; commands and their output are never notification-safe. */
export function summarizeBashToolActivity(kind: "args" | "result", value: unknown): string | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (kind === "args") {
		const command = record.command;
		if (typeof command !== "string") return undefined;
		const program = command.trim().match(/^([A-Za-z][A-Za-z0-9_.+-]*)\b/)?.[1];
		if (
			!program ||
			program.length > 80 ||
			/(?:api[-_ ]?key|access[-_ ]?token|bearer|secret|password|\b(?:sk|pk|rk)-)/i.test(program)
		) {
			return undefined;
		}
		return program;
	}

	const output =
		typeof record.output === "string"
			? record.output
			: Array.isArray(record.content)
				? record.content
						.filter(
							(block): block is { type: unknown; text: unknown } =>
								typeof block === "object" && block !== null && "type" in block && "text" in block,
						)
						.filter(block => block.type === "text" && typeof block.text === "string")
						.map(block => block.text as string)
						.join("\n")
				: undefined;
	if (output === undefined) return undefined;
	const exitCode = typeof record.exitCode === "number" ? `exit=${record.exitCode}` : "completed";
	const lines = output.length === 0 ? 0 : output.split("\n").length;
	return `${exitCode}, ${lines} lines, ${Buffer.byteLength(output, "utf-8")} bytes`;
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
			result?: BashResult | BashInteractiveResult;
	  };

interface ManagedBashJobHandle {
	jobId: string;
	label: string;
	completion: Promise<ManagedBashJobCompletion>;
	getLatestText: () => string;
	setBackgrounded: (backgrounded: boolean) => void;
}

/** The placeholder a folded PTY hands back to its (now finished) foreground call. */
function interactiveResultFromText(text: string): BashInteractiveResult {
	return {
		exitCode: undefined,
		cancelled: false,
		timedOut: false,
		output: text,
		outputBytes: 0,
		outputLines: 0,
		totalBytes: 0,
		totalLines: 0,
		truncated: false,
	};
}

function normalizeResultOutput(result: BashResult | BashInteractiveResult): string {
	return result.output || "";
}

function isInteractiveResult(result: BashResult | BashInteractiveResult): result is BashInteractiveResult {
	return "timedOut" in result;
}

function formatManagedAbortFailure(
	error: unknown,
	result: BashResult | BashInteractiveResult | undefined,
	latestText: string,
): string {
	if (result) {
		const output = normalizeResultOutput(result).replace(/\[Command (?:cancelled|aborted)\]\n?/gu, "");
		return formatBashFailureMessage(result, output || "Command aborted", "Command aborted");
	}
	const raw = error instanceof Error ? error.message : String(error);
	const bodyText = raw.replace(/Command cancelled(?: after \d+ seconds?)?/gu, "").trim() || latestText.trim();
	const bodyBudget = Math.max(0, BASH_ERROR_MAX_BYTES - Buffer.byteLength("Command aborted", "utf-8") - 2);
	const body = truncateTailBytes(bodyText, bodyBudget).text;
	return body.length > 0 ? `${body}\n\nCommand aborted` : "Command aborted";
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
/** Remove the owned registration of a FOREGROUND bash job whose delivery was
 *  synchronously acknowledged: the tuple is settled and must not occupy the
 *  registry, otherwise old retained policies are treated as occupied and the
 *  tombstone FIFO fallback can evict a genuinely live work's policy (review
 *  thread P2). */
function unregisterForegroundOwnedBash(
	manager: { getJob?(id: string): { generation?: string } | undefined },
	jobId: string,
	endpointId?: string,
): void {
	const generation = manager.getJob?.(jobId)?.generation;
	if (!generation) return;
	// The endpoint disambiguates concurrent sessions' same job ids (review P1).
	const registration = lookupOwnedRegistration(jobId, generation, endpointId);
	if (registration) unregisterOwnedRegistration(registration);
}

export class BashTool implements AgentTool<BashToolSchema, BashToolDetails> {
	readonly name = "bash";
	readonly label = "Bash";
	readonly loadMode = "essential";
	readonly description: string;
	readonly parameters: BashToolSchema;
	readonly concurrency = "exclusive";
	readonly strict = true;
	readonly safeSummary = summarizeBashToolActivity;
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
		const trimmedOutput = outputText.trim();
		const renderedOutput =
			trimmedOutput && trimmedOutput !== "(no output)" ? outputText : normalizeResultOutput(result);
		if (result.cancelled) {
			throw new ToolError(formatBashFailureMessage(result, renderedOutput || "Command aborted"));
		}
		if (isInteractiveResult(result) && result.timedOut) {
			const timeoutMessage = `Command timed out after ${timeoutSec} seconds`;
			const message = renderedOutput ? `${renderedOutput}\n\n${timeoutMessage}` : timeoutMessage;
			throw new ToolError(formatBashFailureMessage(result, message));
		}
		if (result.exitCode === undefined) {
			throw new ToolError(formatBashFailureMessage(result, `${outputText}\n\nCommand failed: missing exit status`));
		}
		if (result.exitCode !== 0) {
			throw new ToolError(
				formatBashFailureMessage(result, `${outputText}\n\nCommand exited with code ${result.exitCode}`),
			);
		}
		return outputText;
	}

	#buildCompletedResult(
		result: BashResult | BashInteractiveResult,
		timeoutSec: number,
		options: {
			requestedTimeoutSec?: number;
			notices?: readonly string[];
			terminalId?: string;
			artifactReferenceInBody?: boolean;
		} = {},
	): AgentToolResult<BashToolDetails> {
		const shortArtifactInBody = !result.truncated && result.artifactId !== undefined;
		const baseBody =
			options.artifactReferenceInBody || shortArtifactInBody
				? appendArtifactDetails(this.#formatResultOutput(result), result)
				: this.#formatResultOutput(result);
		const writerNotice = artifactWriterFailureNotice(result);
		const body =
			writerNotice && !baseBody.includes(writerNotice)
				? `${baseBody}${baseBody.endsWith("\n") ? "" : "\n"}${writerNotice}`
				: baseBody;
		const outputLines = [body];
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
		const resultBuilder = toolResult(details)
			.text(outputText)
			.truncationFromSummary(result, {
				direction: "tail",
				...(shortArtifactInBody ? { noticeOwner: "body" } : {}),
			});
		this.#buildResultText(result, timeoutSec, outputText);
		return resultBuilder.done();
	}

	#buildBackgroundStartResult(
		jobId: string,
		label: string,
		previewText: string,
		timeoutSec: number,
		options: { requestedTimeoutSec?: number; notices?: readonly string[]; terminalId?: string } = {},
	): AgentToolResult<BashToolDetails> {
		const details: BashToolDetails = {
			timeoutSeconds: timeoutSec,
			async: { state: "running", jobId, type: "bash" },
		};
		// A folded client terminal keeps its remote handle, so the editor's live
		// terminal card stays bound to the same id after the fold.
		if (options.terminalId !== undefined) details.terminalId = options.terminalId;
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
		/** Immutable attempt-scoped tool call id, when executed via a tool call. */
		toolCallId?: string;
	}): ManagedBashJobHandle {
		const manager = this.#resolveOwnedJobManager();
		if (!manager) {
			throw new ToolError("Background job manager unavailable for this session.");
		}

		const label = options.command.length > 120 ? `${options.command.slice(0, 117)}...` : options.command;
		let latestText = "";
		let backgrounded = options.startBackgrounded;
		const runningDetails = (jobId: string): Record<string, unknown> | undefined =>
			backgrounded ? { async: { state: "running", jobId, type: "bash" } } : undefined;
		const completedDetails = (jobId: string): Record<string, unknown> | undefined =>
			backgrounded ? { async: { state: "completed", jobId, type: "bash" } } : undefined;
		const failedDetails = (jobId: string): Record<string, unknown> | undefined =>
			backgrounded ? { async: { state: "failed", jobId, type: "bash" } } : undefined;
		const completion = Promise.withResolvers<ManagedBashJobCompletion>();

		const jobId = manager.register(
			"bash",
			label,
			async ({ jobId, signal: runSignal, reportProgress }) => {
				const { path: artifactPath, id: artifactId } = (await this.session.allocateOutputArtifact?.("bash")) ?? {};
				const artifactPublisher = createBashArtifactPublisher(this.session);
				const spillThreshold = resolveBashOutputSinkTailBytes(this.session.settings);
				const headBytes = resolveBashOutputSinkHeadBytes(this.session.settings);
				const tailBuffer = new TailBuffer(spillThreshold);

				let executionResult: BashResult | BashInteractiveResult | undefined;
				try {
					const result = await executeBash(options.command, {
						cwd: options.commandCwd,
						settings: this.session.settings,
						sessionKey: `${this.session.getSessionId?.() ?? ""}:async:${jobId}`,
						timeout: options.timeoutMs,
						signal: runSignal,
						env: options.resolvedEnv,
						artifactPath,
						artifactId,
						artifactPublisher,
						spillThreshold,
						headBytes,
						oneShot: true,
						ignoreShellPrefix: this.session.bashRestrictionProfile === "read-only",
						disableShellSnapshot: this.session.bashRestrictionProfile === "read-only",
						onChunk: chunk => {
							tailBuffer.append(chunk);
							latestText = tailBuffer.text();
							void reportProgress(latestText, runningDetails(jobId));
						},
						onRawChunk: chunk => {
							// Forward the unthrottled sanitized chunk to the async-job
							// substrate so the Monitor tool can read the complete process
							// stream by byte offset, independent of the throttled preview
							// path above.
							manager.appendOutput(jobId, chunk);
						},
						onMinimizedSave: async originalText => {
							return saveBashOriginalArtifact(this.session, originalText);
						},
					});
					executionResult = result;
					const finalResult = this.#buildCompletedResult(result, options.timeoutSec, {
						requestedTimeoutSec: options.requestedTimeoutSec,
						notices: options.notices,
						artifactReferenceInBody: true,
					});
					const finalText = this.#extractTextResult(finalResult);
					latestText = finalText;
					completion.resolve({ kind: "completed", result: finalResult });
					await reportProgress(finalText, completedDetails(jobId));
					return finalText;
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					latestText = message;
					completion.resolve({ kind: "failed", error, result: executionResult });
					await reportProgress(message, failedDetails(jobId));
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
		registerOwnedIfLineaged(manager, options.toolCallId, jobId, this.session.getSessionId?.() ?? undefined);

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

	/**
	 * The session's ENDPOINT-owned AsyncJobManager, falling back to the
	 * process-global instance. Concurrent top-level sessions each register
	 * their manager under their endpoint (sdk/session.ts), so a job created
	 * by THIS session must be stored in THIS session's manager — otherwise a
	 * Bash launched by session A lands in the last-created session B's
	 * manager while registering as A-owned, an A scope:"owned" abort then
	 * consults A's endpoint manager and cannot cancel the actual job, and a
	 * later missing-job settlement can retire the tuple while the job keeps
	 * running (review thread P1).
	 */
	#resolveOwnedJobManager(): AsyncJobManager | undefined {
		const endpointId = this.session.getSessionId?.() ?? undefined;
		return (
			this.session.getAsyncJobManager?.() ?? AsyncJobManager.forEndpoint(endpointId) ?? AsyncJobManager.instance()
		);
	}

	async #waitForManagedBashJob(
		job: ManagedBashJobHandle,
		thresholdMs: number,
		signal?: AbortSignal,
		backgroundRequest?: Promise<void>,
	): Promise<ManagedBashJobCompletion | { kind: "running" } | { kind: "aborted" }> {
		if (signal?.aborted) {
			return { kind: "aborted" };
		}

		const threshold = Promise.withResolvers<{ kind: "running" }>();
		const thresholdTimer = setTimeout(() => threshold.resolve({ kind: "running" }), Math.max(0, thresholdMs));
		const waiters: Array<Promise<ManagedBashJobCompletion | { kind: "running" } | { kind: "aborted" }>> = [
			job.completion,
			threshold.promise,
		];
		if (backgroundRequest) {
			waiters.push(backgroundRequest.then(() => ({ kind: "running" as const })));
		}

		let onAbort: (() => void) | undefined;
		if (signal) {
			const aborted = Promise.withResolvers<{ kind: "aborted" }>();
			onAbort = () => aborted.resolve({ kind: "aborted" });
			signal.addEventListener("abort", onAbort, { once: true });
			waiters.push(aborted.promise);
		}
		try {
			return await Promise.race(waiters);
		} finally {
			clearTimeout(thresholdTimer);
			if (signal && onAbort) signal.removeEventListener("abort", onAbort);
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
		const isRestrictedRalplanArtifactEnv =
			allowedPrefixes &&
			allowedPrefixes.length > 0 &&
			this.session.bashRestrictionProfile !== "read-only" &&
			env &&
			Object.keys(env).length === 1 &&
			Object.hasOwn(env, GJC_RALPLAN_ARTIFACT_ENV) &&
			rawCommand.includes(`--artifact-env ${GJC_RALPLAN_ARTIFACT_ENV}`);
		if (
			(this.session.bashRestrictionProfile === "read-only" || (allowedPrefixes && allowedPrefixes.length > 0)) &&
			env &&
			Object.keys(env).length > 0 &&
			!isRestrictedRalplanArtifactEnv
		) {
			const mode = this.session.bashRestrictionProfile === "read-only" ? "Read-only" : "Restricted role-agent";
			throw new ToolError(
				`${mode} bash only allows the ${GJC_RALPLAN_ARTIFACT_ENV} env override for --artifact-env.`,
			);
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

		const activeModel = this.session.model;
		const composerPolicy = checkComposerBashPolicy({
			modelId: this.session.getActiveModelString?.() ?? this.session.getModelString?.() ?? activeModel?.id,
			provider: activeModel?.provider,
			commands: rawCommand === command ? [command] : [rawCommand, command],
		});
		if (!composerPolicy.allowed) {
			throw new ToolError(composerPolicy.message);
		}

		const internalUrlOptions: InternalUrlExpansionOptions = {
			skills: this.session.skills ?? [],
			internalRouter: InternalUrlRouter.instance(),
			localOptions: {
				getArtifactsDir: this.session.getArtifactsDir,
				isManagedDestination: this.session.isManagedSessionDestination,
				getSessionId: this.session.getSessionId,
			},
		};
		command = await expandInternalUrls(command, {
			...internalUrlOptions,
			ensureLocalParentDirs: this.session.bashRestrictionProfile !== "read-only",
		});
		// Issue #5039: refuse tmux write verbs whose target resolves to this
		// agent's own tmux pane — such bytes forge a human `user` turn in the
		// transcript. This is after command expansion but before any spawn, so
		// blocked attempts inject no bytes and create no transcript turn.
		if (this.session.bashRestrictionProfile !== "read-only") {
			const injection = await checkTmuxSelfInjection(command, {
				env: process.env,
				cwd: this.session.cwd,
			});
			if (injection.block) {
				throw new ToolError(injection.reason ?? "Blocked: tmux self-pane injection.");
			}
		}
		const expandedEnv = env
			? Object.fromEntries(
					await Promise.all(
						Object.entries(env).map(async ([key, value]) => [
							key,
							key === GJC_RALPLAN_ARTIFACT_ENV
								? value
								: await expandInternalUrls(value, {
										...internalUrlOptions,
										ensureLocalParentDirs: true,
										noEscape: true,
									}),
						]),
					),
				)
			: undefined;
		// Spawned workflow commands must resolve the SESSION's agent
		// profile: the child's getAgentDir() reads GJC_CODING_AGENT_DIR at
		// module load. Injected per-command (session-scoped), never
		// mutating the host process; an explicit tool-call env wins. The
		// session's REQUESTED directory (getSessionAgentDir) takes
		// precedence over the global Settings singleton, which may belong
		// to an earlier session.
		const sessionAgentDir = this.session.getSessionAgentDir?.() ?? this.session.settings?.getAgentDir?.();
		// An EXPLICIT tool-call env that supplies either supported spelling of
		// the agent-directory override wins over the session injection: the
		// child's getAgentDir() prefers GJC_CODING_AGENT_DIR, so injecting it
		// while the caller only set the legacy PI_CODING_AGENT_DIR alias would
		// silently ignore the caller's override.
		const explicitAgentDirOverride =
			expandedEnv?.GJC_CODING_AGENT_DIR !== undefined || expandedEnv?.PI_CODING_AGENT_DIR !== undefined;
		const resolvedEnv = {
			...buildGjcRuntimeSessionEnv({
				sessionFile: null,
				sessionId: this.session.getSessionId?.(),
				cwd: this.session.cwd,
			}),
			...(sessionAgentDir && !explicitAgentDirOverride ? { GJC_CODING_AGENT_DIR: sessionAgentDir } : {}),
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
		const sleepAdvisory = longSleepAdvisory(command, timeoutSec);
		if (sleepAdvisory) notices.push(sleepAdvisory);

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
			toolCallId?: string;
			onRawLine?: (line: string, jobId: string) => void;
			shouldAcceptRawLine?: (jobId: string) => boolean;
			lifecycle?: import("../async").AsyncJobLifecycleCleanup;
		} = {},
	): Promise<{ jobId: string; label: string; commandCwd: string }> {
		const manager = this.#resolveOwnedJobManager();
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
				const artifactPublisher = createBashArtifactPublisher(this.session);
				const spillThreshold = resolveBashOutputSinkTailBytes(this.session.settings);
				const headBytes = resolveBashOutputSinkHeadBytes(this.session.settings);
				const tailBuffer = new TailBuffer(spillThreshold);

				try {
					const result = await executeBash(prepared.command, {
						cwd: prepared.commandCwd,
						settings: this.session.settings,
						sessionKey: `${this.session.getSessionId?.() ?? ""}:monitor:${id}`,
						timeout: monitorTimeoutMs,
						signal,
						env: prepared.resolvedEnv,
						artifactPath,
						artifactId,
						artifactPublisher,
						spillThreshold,
						headBytes,
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
						onMinimizedSave: async originalText => saveBashOriginalArtifact(this.session, originalText),
					});
					flushTrailingLine();
					const resultText = appendArtifactDetails(result.output || "(no output)", result);
					this.#buildResultText(result, prepared.timeoutSec, resultText);
					return resultText;
				} catch (error) {
					flushTrailingLine();
					throw error instanceof Error ? error : new Error(String(error));
				}
			},
			{ ownerId, metadata: { monitor: true }, lifecycle: opts.lifecycle },
		);
		// Monitor jobs are exact owned background work of the turn that started
		// them: register the five-tuple so scope:"owned" terminal abort stops the
		// monitor too (review thread P2).
		registerOwnedIfLineaged(manager, opts.toolCallId, jobId, this.session.getSessionId?.() ?? undefined);
		currentJobId = jobId;
		return { jobId, label, commandCwd: prepared.commandCwd };
	}

	async execute(
		toolCallId: string,
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
			// Availability is endpoint-first: a concurrent top-level session
			// that was the process-global instance may have been disposed,
			// clearing instance() while THIS session's manager stays
			// registered by endpoint (review thread P1).
			if (!this.#resolveOwnedJobManager()) {
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
				toolCallId,
			});
			return this.#buildBackgroundStartResult(job.jobId, job.label, "", timeoutSec, {
				requestedTimeoutSec,
				notices: pendingNotices,
			});
		}

		// Route through the client terminal when the client advertises the terminal capability.
		// Skip when pty=true (PTY needs the local terminal UI).
		const clientBridge =
			this.session.bashRestrictionProfile === "read-only" ? undefined : this.session.getClientBridge?.();
		const clientTerminalActive = Boolean(clientBridge?.capabilities.terminal && clientBridge.createTerminal && !pty);

		// Run non-PTY bash through the managed job path so Ctrl+B-twice fold-on-demand works
		// even when auto-background is disabled. When a client terminal will handle the
		// command, keep the existing bridge path unless auto-background is enabled.
		// The manager is resolved ONCE from the session's endpoint (same instance the
		// job was created in) and reused for creation, acknowledgement, cancellation,
		// and unregistering — the process-global instance may belong to a different
		// concurrent top-level session (review thread P1).
		const ownedManager = this.#resolveOwnedJobManager();
		// The client-terminal path is now itself manager-backed and foldable, so it no
		// longer has to be bypassed to make folding work. A capable ACP session keeps
		// its terminal contract and still folds.
		if (!pty && ownedManager && !clientTerminalActive) {
			// With auto-background off, wait past the command's own timeout so the job only
			// leaves the foreground on an explicit Ctrl+B fold, never on an auto-background timer.
			const autoBackgroundWaitMs = this.#autoBackgroundEnabled
				? this.#resolveAutoBackgroundWaitMs(timeoutMs)
				: timeoutMs + 1_000;
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
				toolCallId,
			});
			if (startBackgrounded) {
				return this.#buildBackgroundStartResult(job.jobId, job.label, "", timeoutSec, {
					requestedTimeoutSec,
					notices: pendingNotices,
				});
			}
			const backgroundRequest = Promise.withResolvers<void>();
			// Exactly one party may settle the foreground caller. detachObserver (the
			// fold won) and resolveForegroundObserver (a completion was handed back
			// after a failed fold) share this flag, so a race cannot double-settle.
			let foregroundSettled = false;
			const settleForeground = (): "resolved" | "already-settled" => {
				if (foregroundSettled) return "already-settled";
				foregroundSettled = true;
				return "resolved";
			};
			const jobGeneration = ownedManager.getJob(job.jobId)?.generation ?? job.jobId;
			const unregisterBackgroundRequest = this.session.registerForegroundFoldParticipant?.({
				kind: "bash-managed",
				jobId: job.jobId,
				jobGeneration,
				label: job.label,
				cwdSensitive: true,
				outputRef: {
					jobId: job.jobId,
					generation: jobGeneration,
					instruction: `Use the job tool's tail operation for ${job.jobId} to read this command's output.`,
				},
				// Bound at registration over the manager that registered THIS job, so
				// identity can never resolve to another manager's identically-named job.
				getJob: () => {
					const current = ownedManager.getJob(job.jobId);
					return current?.generation === jobGeneration ? current : undefined;
				},
				detachObserver: () => {
					const outcome = settleForeground();
					if (outcome === "resolved") {
						job.setBackgrounded(true);
						ownedManager.markBackgrounded(job.jobId, jobGeneration);
						backgroundRequest.resolve();
					}
					return outcome;
				},
				resolveForegroundObserver: () => settleForeground(),
			});
			let waitResult: ManagedBashJobCompletion | { kind: "running" } | { kind: "aborted" };
			try {
				waitResult = await this.#waitForManagedBashJob(
					job,
					autoBackgroundWaitMs,
					signal,
					backgroundRequest.promise,
				);
			} finally {
				unregisterBackgroundRequest?.();
			}
			if (waitResult.kind === "completed") {
				ownedManager.acknowledgeDeliveries([job.jobId]);
				unregisterForegroundOwnedBash(ownedManager, job.jobId, this.session.getSessionId?.() ?? "local");
				return waitResult.result;
			}
			if (waitResult.kind === "failed") {
				ownedManager.acknowledgeDeliveries([job.jobId]);
				unregisterForegroundOwnedBash(ownedManager, job.jobId, this.session.getSessionId?.() ?? "local");
				throw waitResult.error;
			}
			if (waitResult.kind === "aborted") {
				ownedManager.cancel(job.jobId);
				const terminal = await job.completion;
				ownedManager.acknowledgeDeliveries([job.jobId]);
				unregisterForegroundOwnedBash(ownedManager, job.jobId, this.session.getSessionId?.() ?? "local");
				if (terminal.kind === "failed") {
					throw new ToolAbortError(
						formatManagedAbortFailure(terminal.error, terminal.result, job.getLatestText()),
					);
				}
				throw new ToolAbortError(formatManagedAbortFailure(undefined, undefined, job.getLatestText()));
			}
			job.setBackgrounded(true);
			return this.#buildBackgroundStartResult(job.jobId, job.label, job.getLatestText(), timeoutSec, {
				requestedTimeoutSec,
				notices: pendingNotices,
			});
		}

		if (clientBridge?.capabilities.terminal && clientBridge.createTerminal && !pty) {
			const clientHeadBytes = resolveBashOutputSinkHeadBytes(this.session.settings);
			const clientTailBytes = resolveBashOutputSinkTailBytes(this.session.settings);
			const handle = await clientBridge.createTerminal({
				command,
				cwd: commandCwd,
				env: resolvedEnv
					? Object.entries(resolvedEnv).map(([name, value]) => ({ name, value: value as string }))
					: undefined,
				outputByteLimit: clientHeadBytes > 0 ? undefined : clientTailBytes,
			});

			// Emit partial update so the editor can embed the live terminal card.
			onUpdate?.({ content: [], details: { terminalId: handle.terminalId } });

			// The remote terminal is released exactly once, by whichever path settles
			// it: a foreground return, a folded background completion, or a failure.
			let released = false;
			const releaseTerminalOnce = async (): Promise<void> => {
				if (released) return;
				released = true;
				try {
					await handle.release();
				} catch (error) {
					logger.warn("ACP terminal release failed", { terminalId: handle.terminalId, error });
				}
			};
			let latestText = "";

			const runToCompletion = async (
				runSignal: AbortSignal | undefined,
			): Promise<AgentToolResult<BashToolDetails>> => {
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
				let killPromise: Promise<void> | undefined;
				const fireKill = (): Promise<void> => {
					if (killPromise) return killPromise;
					killPromise = handle.kill().catch((error: unknown) => {
						logger.warn("ACP terminal kill failed", { terminalId: handle.terminalId, error });
					});
					return killPromise;
				};
				const onAbortSignal = () => {
					resolveAborted();
					void fireKill();
				};
				runSignal?.addEventListener("abort", onAbortSignal, { once: true });

				try {
					if (runSignal?.aborted) {
						await fireKill();
						let current: ClientBridgeTerminalOutput = { output: "", truncated: false };
						let readDiagnostic: string | undefined;
						try {
							current = await handle.currentOutput();
						} catch (error) {
							readDiagnostic = boundArtifactSaveDiagnostic(error);
							logger.warn("ACP terminal aborted output read failed", {
								terminalId: handle.terminalId,
								error,
							});
						}
						const prepared = await prepareClientTerminalOutput(this.session, current);
						throw new ToolAbortError(formatClientTerminalAbortFailure(prepared, readDiagnostic, pendingNotices));
					}

					const timeoutPromise = Bun.sleep(timeoutMs).then(() => ({ kind: "timeout" as const }));
					// Poll until the process exits, times out, or the caller aborts.
					for (;;) {
						const racers: Array<Promise<BridgeRaceResult>> = [
							exitPromise.then(s => ({ kind: "exit" as const, status: s })),
							timeoutPromise,
							Bun.sleep(250).then(() => ({ kind: "poll" as const })),
						];
						if (runSignal) {
							racers.push(abortedP.then(() => ({ kind: "aborted" as const })));
						}
						const raced = await Promise.race(racers);

						if (raced.kind === "aborted" || runSignal?.aborted) {
							await fireKill();
							let current: ClientBridgeTerminalOutput = { output: "", truncated: false };
							let readDiagnostic: string | undefined;
							try {
								current = await handle.currentOutput();
							} catch (error) {
								readDiagnostic = boundArtifactSaveDiagnostic(error);
								logger.warn("ACP terminal aborted output read failed", {
									terminalId: handle.terminalId,
									error,
								});
							}
							const prepared = await prepareClientTerminalOutput(this.session, current);
							throw new ToolAbortError(
								formatClientTerminalAbortFailure(prepared, readDiagnostic, pendingNotices),
							);
						}

						if (raced.kind === "timeout") {
							// Kill before reading final output so a slow `terminal/output`
							// RPC cannot let a timed-out command keep running past the
							// enforced timeout. The handle stays valid post-kill so the
							// buffered output is still readable.
							await fireKill();
							let current: ClientBridgeTerminalOutput = { output: "", truncated: false };
							let readDiagnostic: string | undefined;
							try {
								current = await handle.currentOutput();
							} catch (error) {
								readDiagnostic = boundArtifactSaveDiagnostic(error);
								logger.warn("ACP terminal final output read failed", {
									terminalId: handle.terminalId,
									error,
								});
							}
							const prepared = await prepareClientTerminalOutput(this.session, current);
							const timeoutNotices = [
								...pendingNotices,
								...(current.truncated || prepared.locallyTruncated ? ["(output truncated)"] : []),
								...(prepared.artifactSaveNotice ? [prepared.artifactSaveNotice] : []),
								...(readDiagnostic ? [`Terminal output recovery failed: ${readDiagnostic}`] : []),
							];
							const timedOutResult: BashInteractiveResult = {
								...prepared.summary,
								exitCode: undefined,
								cancelled: false,
								timedOut: true,
							};
							return this.#buildCompletedResult(timedOutResult, timeoutSec, {
								requestedTimeoutSec,
								notices: timeoutNotices,
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
							// observe `runSignal?.aborted` and exit via the abort branch.
							continue;
						}
						const { summary, locallyTruncated } = await boundClientTerminalOutput(
							pollOutput.output,
							pollOutput.truncated,
							this.session.settings,
						);
						const pollText =
							pollOutput.truncated || locallyTruncated
								? `${summary.output}${summary.output.endsWith("\n") ? "" : "\n"}(output truncated)`
								: summary.output;
						latestText = pollText;
						onUpdate?.({
							content: [{ type: "text", text: pollText }],
							details: { terminalId: handle.terminalId },
						});
					}
				} finally {
					runSignal?.removeEventListener("abort", onAbortSignal);
				}

				if (runSignal?.aborted) {
					await fireKill();
					let current: ClientBridgeTerminalOutput = { output: "", truncated: false };
					let readDiagnostic: string | undefined;
					try {
						current = await handle.currentOutput();
					} catch (error) {
						readDiagnostic = boundArtifactSaveDiagnostic(error);
						logger.warn("ACP terminal aborted output read failed", {
							terminalId: handle.terminalId,
							error,
						});
					}
					const prepared = await prepareClientTerminalOutput(this.session, current);
					throw new ToolAbortError(formatClientTerminalAbortFailure(prepared, readDiagnostic, pendingNotices));
				}

				// Fetch final output; the terminal is released in the outer finally.
				const finalOutput = await handle.currentOutput();

				// Map exit status: null exitCode with a signal → treat as signal kill (137).
				const rawExitCode = exitStatus.exitCode;
				const exitCode: number | undefined =
					rawExitCode != null ? rawExitCode : exitStatus.signal ? 137 : undefined;

				const prepared = await prepareClientTerminalOutput(this.session, finalOutput);

				const bridgeResult: BashResult = {
					...prepared.summary,
					exitCode,
					cancelled: false,
				};

				const bridgeNotices: string[] = [];
				if (finalOutput.truncated || prepared.locallyTruncated) bridgeNotices.push("(output truncated)");
				for (const notice of pendingNotices) bridgeNotices.push(notice);
				if (prepared.artifactSaveNotice) bridgeNotices.push(prepared.artifactSaveNotice);

				return this.#buildCompletedResult(bridgeResult, timeoutSec, {
					requestedTimeoutSec,
					notices: bridgeNotices,
					terminalId: handle.terminalId,
				});
			};

			// Without a job manager nothing can fold this, so ownership never leaves the
			// foreground call.
			if (!ownedManager) {
				try {
					return await runToCompletion(signal);
				} finally {
					await releaseTerminalOnce();
				}
			}

			// Manager-backed runner: the remote command keeps running after a fold and
			// its completion is delivered like any other background job. createTerminal
			// already ran above, so exactly ONE remote handle exists and is retained
			// across the fold.
			const bridgeManager = ownedManager;
			const bridgeEndpointId = this.session.getSessionId?.() ?? "local";
			const bridgeLabel = command.length > 120 ? `${command.slice(0, 117)}...` : command;
			const bridgeCompletion = Promise.withResolvers<ManagedBashJobCompletion>();
			let bridgeBackgrounded = false;

			const bridgeJobId = bridgeManager.register(
				"bash",
				bridgeLabel,
				async ({ jobId, signal: runSignal, reportProgress }) => {
					try {
						const result = await runToCompletion(runSignal);
						const finalText = this.#extractTextResult(result);
						latestText = finalText;
						bridgeCompletion.resolve({ kind: "completed", result });
						await reportProgress(
							finalText,
							bridgeBackgrounded ? { async: { state: "completed", jobId, type: "bash" } } : undefined,
						);
						return finalText;
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						latestText = message;
						bridgeCompletion.resolve({ kind: "failed", error });
						await reportProgress(
							message,
							bridgeBackgrounded ? { async: { state: "failed", jobId, type: "bash" } } : undefined,
						);
						throw error;
					} finally {
						await releaseTerminalOnce();
					}
				},
				{
					ownerId: this.session.getAgentId?.() ?? undefined,
					onProgress: async (text: string) => {
						latestText = text;
					},
				},
			);

			const bridgeGeneration = bridgeManager.getJob(bridgeJobId)?.generation ?? bridgeJobId;
			// Owner teardown must not swallow a live remote command. failNow is the one
			// transition that both fails the job AND enqueues its delivery, so the
			// failure stays visible instead of becoming a cancelled job that delivers
			// nothing.
			const unregisterOwnerCleanup = bridgeManager.registerOwnerCleanup(
				this.session.getAgentId?.() ?? "0-Main",
				() => {
					bridgeManager.failNow(bridgeJobId, bridgeGeneration, "Client terminal owner was torn down.");
				},
			);

			const bridgeHandle: ManagedBashJobHandle = {
				jobId: bridgeJobId,
				label: bridgeLabel,
				completion: bridgeCompletion.promise,
				getLatestText: () => latestText,
				setBackgrounded: (next: boolean) => {
					bridgeBackgrounded = next;
				},
			};

			const bridgeFoldRequest = Promise.withResolvers<void>();
			let bridgeForegroundSettled = false;
			const settleBridgeForeground = (): "resolved" | "already-settled" => {
				if (bridgeForegroundSettled) return "already-settled";
				bridgeForegroundSettled = true;
				return "resolved";
			};
			const unregisterBridgeFold = this.session.registerForegroundFoldParticipant?.({
				kind: "client-terminal",
				jobId: bridgeJobId,
				jobGeneration: bridgeGeneration,
				label: bridgeLabel,
				cwdSensitive: true,
				outputRef: {
					jobId: bridgeJobId,
					generation: bridgeGeneration,
					instruction: `Use the job tool's tail operation for ${bridgeJobId} to read this command's output.`,
				},
				getJob: () => {
					const current = bridgeManager.getJob(bridgeJobId);
					return current?.generation === bridgeGeneration ? current : undefined;
				},
				detachObserver: () => {
					const outcome = settleBridgeForeground();
					if (outcome === "resolved") {
						bridgeHandle.setBackgrounded(true);
						bridgeManager.markBackgrounded(bridgeJobId, bridgeGeneration);
						bridgeFoldRequest.resolve();
					}
					return outcome;
				},
				resolveForegroundObserver: () => settleBridgeForeground(),
			});

			let bridgeWait: ManagedBashJobCompletion | { kind: "running" } | { kind: "aborted" };
			try {
				bridgeWait = await this.#waitForManagedBashJob(
					bridgeHandle,
					this.#autoBackgroundEnabled ? this.#resolveAutoBackgroundWaitMs(timeoutMs) : timeoutMs + 1_000,
					signal,
					bridgeFoldRequest.promise,
				);
			} finally {
				unregisterBridgeFold?.();
			}

			if (bridgeWait.kind === "completed") {
				unregisterOwnerCleanup();
				bridgeManager.acknowledgeDeliveries([bridgeJobId]);
				unregisterForegroundOwnedBash(bridgeManager, bridgeJobId, bridgeEndpointId);
				return bridgeWait.result;
			}
			if (bridgeWait.kind === "failed") {
				unregisterOwnerCleanup();
				bridgeManager.acknowledgeDeliveries([bridgeJobId]);
				unregisterForegroundOwnedBash(bridgeManager, bridgeJobId, bridgeEndpointId);
				throw bridgeWait.error;
			}
			if (bridgeWait.kind === "aborted") {
				unregisterOwnerCleanup();
				bridgeManager.cancel(bridgeJobId);
				const terminal = await bridgeHandle.completion;
				bridgeManager.acknowledgeDeliveries([bridgeJobId]);
				unregisterForegroundOwnedBash(bridgeManager, bridgeJobId, bridgeEndpointId);
				if (terminal.kind === "failed") {
					throw new ToolAbortError(
						formatManagedAbortFailure(terminal.error, undefined, bridgeHandle.getLatestText()),
					);
				}
				throw new ToolAbortError(formatManagedAbortFailure(undefined, undefined, bridgeHandle.getLatestText()));
			}

			// Folded (or auto-backgrounded): the remote terminal keeps running and its
			// result arrives as a background completion.
			bridgeHandle.setBackgrounded(true);
			return this.#buildBackgroundStartResult(bridgeJobId, bridgeLabel, bridgeHandle.getLatestText(), timeoutSec, {
				requestedTimeoutSec,
				notices: pendingNotices,
				terminalId: handle.terminalId,
			});
		}

		const spillThreshold = resolveBashOutputSinkTailBytes(this.session.settings);
		const headBytes = resolveBashOutputSinkHeadBytes(this.session.settings);

		// Track output for streaming updates (tail only)
		const tailBuffer = new TailBuffer(spillThreshold);

		// Allocate artifact for truncated output storage
		const { path: artifactPath, id: artifactId } = (await this.session.allocateOutputArtifact?.("bash")) ?? {};
		const artifactPublisher = createBashArtifactPublisher(this.session);

		const interactiveUi =
			this.session.bashRestrictionProfile === "read-only"
				? undefined
				: canUseInteractiveBashPty(pty, ctx)
					? ctx?.ui
					: undefined;
		// A PTY command is foldable too: the runner owns the session, so the fold
		// registers a job that delivers the run's real outcome after the foreground
		// has already returned.
		let ptyFoldUnregister: (() => void) | undefined;
		let ptyFoldResult: AgentToolResult<BashToolDetails> | undefined;
		const result: BashResult | BashInteractiveResult = interactiveUi
			? await runInteractiveBashPty(interactiveUi, {
					command,
					cwd: commandCwd,
					settings: this.session.settings,
					timeoutMs,
					signal,
					env: resolvedEnv,
					artifactPath,
					artifactId,
					artifactPublisher,
					spillThreshold,
					headBytes,
					onControls: controls => {
						if (!ownedManager) return;
						const ptyManager = ownedManager;
						const ptyLabel = command.length > 120 ? `${command.slice(0, 117)}...` : command;
						// The job's runner simply awaits the run that is ALREADY executing,
						// so registering never re-executes the command.
						const ptyJobId = ptyManager.register(
							"bash",
							ptyLabel,
							async () => {
								const outcome = await controls.terminalCompletion;
								return this.#extractTextResult(
									this.#buildCompletedResult(outcome, timeoutSec, { requestedTimeoutSec }),
								);
							},
							{ ownerId: this.session.getAgentId?.() ?? undefined },
						);
						const ptyGeneration = ptyManager.getJob(ptyJobId)?.generation ?? ptyJobId;
						ptyFoldUnregister = this.session.registerForegroundFoldParticipant?.({
							kind: "bash-pty",
							jobId: ptyJobId,
							jobGeneration: ptyGeneration,
							label: ptyLabel,
							cwdSensitive: true,
							outputRef: {
								jobId: ptyJobId,
								generation: ptyGeneration,
								instruction: `Use the job tool's tail operation for ${ptyJobId} to read this command's output.`,
							},
							getJob: () => {
								const current = ptyManager.getJob(ptyJobId);
								return current?.generation === ptyGeneration ? current : undefined;
							},
							detachObserver: () => {
								// Output-only continuation: stdin forwarding ends here and the
								// process is never killed or restarted by folding.
								ptyManager.markBackgrounded(ptyJobId, ptyGeneration);
								const started = this.#buildBackgroundStartResult(ptyJobId, ptyLabel, "", timeoutSec, {
									requestedTimeoutSec,
									notices: pendingNotices,
								});
								const outcome = controls.detachObserver(
									interactiveResultFromText(this.#extractTextResult(started)),
								);
								if (outcome === "resolved") ptyFoldResult = started;
								return outcome;
							},
							resolveForegroundObserver: () => "already-settled",
						});
					},
				})
			: await executeBash(command, {
					cwd: commandCwd,
					settings: this.session.settings,
					sessionKey: this.session.getSessionId?.() ?? undefined,
					oneShot: this.session.bashRestrictionProfile === "read-only",
					timeout: timeoutMs,
					signal,
					env: resolvedEnv,
					artifactPath,
					artifactId,
					artifactPublisher,
					spillThreshold,
					headBytes,
					onChunk: streamTailUpdates(tailBuffer, onUpdate),
					onMinimizedSave: async originalText => saveBashOriginalArtifact(this.session, originalText),
					ignoreShellPrefix: this.session.bashRestrictionProfile === "read-only",
					disableShellSnapshot: this.session.bashRestrictionProfile === "read-only",
				});
		ptyFoldUnregister?.();
		// Folded: the foreground was settled by the fold, so return the background
		// -start result verbatim instead of presenting a half-finished command.
		if (ptyFoldResult) return ptyFoldResult;

		if (result.cancelled) {
			const noticeSuffix = pendingNotices.length > 0 ? `\n\n${pendingNotices.join("\n")}` : "";
			const baseCancelledText = normalizeResultOutput(result) || "Command aborted";
			if (signal?.aborted) {
				throw new ToolAbortError(formatBashFailureMessage(result, baseCancelledText, "Command aborted"));
			}
			const failureText = `${baseCancelledText}${noticeSuffix}`;
			throw new ToolError(formatBashFailureMessage(result, failureText));
		}
		if (isInteractiveResult(result) && result.timedOut) {
			const timeoutMessage = `Command timed out after ${timeoutSec} seconds`;
			const output = normalizeResultOutput(result);
			const noticeSuffix = pendingNotices.length > 0 ? `\n\n${pendingNotices.join("\n")}` : "";
			const baseText = output ? `${output}\n\n${timeoutMessage}` : timeoutMessage;
			const failureText = `${baseText}${noticeSuffix}`;
			throw new ToolError(formatBashFailureMessage(result, failureText, timeoutMessage));
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
	compactCommand?: boolean;
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

const BASH_COLLAPSED_COMMAND_MAX_VISUAL_ROWS = 5;
const BASH_COMMAND_SENTINEL_MAX_VISUAL_ROWS = 3;

interface BashCommandProjection {
	lines: string[];
}

function resolveBashExpandKeyLabel(): string | undefined {
	return getKeybindings().getKeys("app.tools.expand")[0];
}

function formatBashExpandActionHint(maxWidth?: number): string {
	const keyLabel = resolveBashExpandKeyLabel();
	const actionHint = keyLabel ? `${keyLabel} to expand` : "expand tools";
	return maxWidth !== undefined && visibleWidth(actionHint) > Math.max(1, maxWidth) ? "expand tools" : actionHint;
}

function renderBashCommandProjection(
	commandLines: string[],
	width: number,
	expanded: boolean,
	actionHint: string,
	uiTheme: Theme,
): BashCommandProjection {
	const renderWidth = Math.max(1, width);
	const visualLines = new Text(commandLines.join("\n"), 0, 0).render(renderWidth);
	if (expanded || visualLines.length <= BASH_COLLAPSED_COMMAND_MAX_VISUAL_ROWS) {
		return { lines: visualLines };
	}

	const retained = visualLines.slice(0, BASH_COLLAPSED_COMMAND_MAX_VISUAL_ROWS);
	const omittedVisualRows = visualLines.length - retained.length;
	let sentinel = new Text(
		uiTheme.fg("dim", `… ${omittedVisualRows} command rows omitted\n${actionHint}`),
		0,
		0,
	).render(renderWidth);

	if (sentinel.length > BASH_COMMAND_SENTINEL_MAX_VISUAL_ROWS) {
		sentinel = new Text(uiTheme.fg("dim", `… ${omittedVisualRows} rows omitted\nexpand tools`), 0, 0).render(
			renderWidth,
		);
	}
	if (sentinel.length > BASH_COMMAND_SENTINEL_MAX_VISUAL_ROWS) {
		sentinel = [
			uiTheme.fg("dim", truncateToWidth(`… +${omittedVisualRows}`, renderWidth)),
			uiTheme.fg("dim", truncateToWidth("expand tools", renderWidth)),
		];
	}

	return { lines: [...retained, ...sentinel] };
}

function createBashCommandProjector(commandLines: string[], uiTheme: Theme) {
	let cached:
		| {
				width: number;
				expanded: boolean;
				actionHint: string;
				projection: BashCommandProjection;
		  }
		| undefined;

	return {
		render(width: number, expanded: boolean): BashCommandProjection {
			const actionHint = formatBashExpandActionHint(width);
			if (cached?.width === width && cached.expanded === expanded && cached.actionHint === actionHint) {
				return cached.projection;
			}
			const projection = renderBashCommandProjection(commandLines, width, expanded, actionHint, uiTheme);
			cached = { width, expanded, actionHint, projection };
			return projection;
		},
		invalidate(): void {
			cached = undefined;
		},
	};
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
			const title = config.resolveTitle(args, options);
			if (!config.compactCommand) {
				const cmdText = formatBashCommand(renderArgs);
				const text = renderStatusLine({ icon: "pending", title, description: cmdText }, uiTheme);
				return new Text(text, 0, 0);
			}

			const header = renderStatusLine({ icon: "pending", title }, uiTheme);
			const projectCommand = createBashCommandProjector(formatBashCommandLines(renderArgs, uiTheme), uiTheme);
			const renderOptions = options as RenderResultOptions & { renderContext?: BashRenderContext };
			return {
				render: (width: number): string[] => {
					const expanded = renderOptions.renderContext?.expanded ?? renderOptions.expanded;
					return [header, ...projectCommand.render(width, expanded).lines];
				},
				invalidate: () => projectCommand.invalidate(),
			};
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
			const projectCommand =
				config.compactCommand && cmdLines ? createBashCommandProjector(cmdLines, uiTheme) : undefined;
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
					const commandLines =
						cmdLines && projectCommand
							? projectCommand.render(getOutputBlockContentWidth(width, uiTheme), expanded).lines
							: (cmdLines ?? []);

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
										`… (${result.skippedCount} earlier lines, showing ${result.visualLines.length} of ${result.skippedCount + result.visualLines.length}) (${formatBashExpandActionHint(getOutputBlockContentWidth(width, uiTheme))})`,
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
								{ lines: commandLines },
								{ label: uiTheme.fg("toolTitle", "Output"), lines: outputLines },
							],
							width,
						},
						uiTheme,
					);
				},
				invalidate: () => {
					outputBlock.invalidate();
					projectCommand?.invalidate();
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
	compactCommand: true,
});
