import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@gajae-code/agent-core";
import type { Component } from "@gajae-code/tui";
import { Text } from "@gajae-code/tui";
import { prompt } from "@gajae-code/utils";
import * as z from "zod/v4";
import type { SSHHost } from "../capability/ssh";
import { sshCapability } from "../capability/ssh";
import { getDefault, type Settings } from "../config/settings";
import { loadCapability } from "../discovery";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import sshDescriptionBase from "../prompts/tools/ssh.md" with { type: "text" };
import type { SessionArtifactPublication } from "../session/session-manager";
import {
	DEFAULT_MAX_BYTES,
	streamTailUpdates,
	TailBuffer,
	type TerminalArtifactPublisher,
	type TruncationResult,
	truncateMiddle,
	truncateMiddleWindows,
	truncateTail,
} from "../session/streaming-output";
import type { SSHHostInfo } from "../ssh/connection-manager";
import { ensureHostInfo, getHostInfoForHost } from "../ssh/connection-manager";
import { executeSSH, type SSHResult } from "../ssh/ssh-executor";
import { renderStatusLine } from "../tui";
import { CachedOutputBlock } from "../tui/output-block";
import type { ToolSession } from ".";
import { wrapUntrustedContent } from "./fetch";
import {
	formatArtifactReference,
	formatStyledTruncationWarning,
	type OutputMeta,
	stripOutputNotice,
} from "./output-meta";
import { ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";
import { clampTimeout } from "./tool-timeouts";
export const SSH_DESCRIPTION = prompt.render(sshDescriptionBase);

export const sshSchema = z.object({
	host: z.string().describe("ssh host"),
	command: z.string().describe("remote command"),
	cwd: z.string().optional().describe("remote working directory"),
	timeout: z.number().optional().describe("timeout in seconds").default(60),
});

export interface SSHToolDetails {
	meta?: OutputMeta;
}

async function formatHostEntry(host: SSHHost): Promise<string> {
	const info = await getHostInfoForHost(host);

	let shell: string;
	if (!info) {
		shell = "detecting...";
	} else if (info.os === "windows") {
		if (info.compatEnabled) {
			const compatShell = info.compatShell || "bash";
			shell = `windows/${compatShell}`;
		} else if (info.shell === "powershell") {
			shell = "windows/powershell";
		} else {
			shell = "windows/cmd";
		}
	} else if (info.os === "linux") {
		shell = `linux/${info.shell}`;
	} else if (info.os === "macos") {
		shell = `macos/${info.shell}`;
	} else {
		shell = `unknown/${info.shell}`;
	}

	return `- ${host.name} (${host.host}) | ${shell}`;
}

async function formatDescription(hosts: SSHHost[]): Promise<string> {
	const baseDescription = prompt.render(sshDescriptionBase);
	if (hosts.length === 0) {
		return baseDescription;
	}
	const hostList = (await Promise.all(hosts.map(formatHostEntry))).join("\n");
	return `${baseDescription}\n\nAvailable hosts:\n${hostList}`;
}

function quoteRemotePath(value: string): string {
	if (value.length === 0) {
		return "''";
	}
	const escaped = value.replace(/'/g, "'\\''");
	return `'${escaped}'`;
}

function quotePowerShellPath(value: string): string {
	if (value.length === 0) {
		return "''";
	}
	const escaped = value.replace(/'/g, "''");
	return `'${escaped}'`;
}

function quoteCmdPath(value: string): string {
	const escaped = value.replace(/"/g, '""');
	return `"${escaped}"`;
}

const FENCE_OPEN = "<untrusted-content>\n";
const FENCE_CLOSE = "\n</untrusted-content>";
const UNTRUSTED_FENCE_OVERHEAD = Buffer.byteLength(`${FENCE_OPEN}${FENCE_CLOSE}`, "utf-8");
const INLINE_MARKER_RESERVE = 256;
/** `</untrusted-content>` grows when `wrapUntrustedContent` escapes it. */
const CLOSER_RAW_BYTES = "</untrusted-content>".length;
const CLOSER_ESCAPED_BYTES = "&lt;/untrusted-content&gt;".length;

type OutputBudgetPath = "tools.maxInlineResultBytes" | "tools.artifactHeadBytes" | "tools.artifactTailLines";

function settingNumber(settings: Settings | undefined, path: OutputBudgetPath): number {
	return settings?.get(path) ?? getDefault(path);
}

type RemoteFrame = {
	text: string;
	truncation?: TruncationResult;
	direction?: "head" | "tail" | "middle";
	/** True only after the full remote text is already stored. */
	shrunk: boolean;
	visibleLines: number;
	visibleBytes: number;
};

function inlineCapBytes(settings: Settings | undefined): number {
	return settingNumber(settings, "tools.maxInlineResultBytes") * 1024;
}

function exceedsInlineCap(output: string, settings: Settings | undefined): boolean {
	const cap = inlineCapBytes(settings);
	if (cap <= 0) return false;
	// Measure the escaped frame. A raw-size check misses closer expansion.
	return Buffer.byteLength(wrapUntrustedContent(output), "utf-8") > cap;
}

function frameFullRemoteOutput(output: string): RemoteFrame {
	return { text: wrapUntrustedContent(output), shrunk: false, visibleLines: 0, visibleBytes: 0 };
}

/**
 * Cut to the inline window, then frame that excerpt. Call only when the full
 * remote text is already stored, so a tail cut cannot drop the opening fence
 * or the only copy of the output.
 */
function frameShrunkRemoteOutput(output: string, settings: Settings | undefined): RemoteFrame {
	const cap = inlineCapBytes(settings);
	const escapedRoom = Math.max(1, cap - UNTRUSTED_FENCE_OVERHEAD - INLINE_MARKER_RESERVE);
	// Budget in remote-output bytes so framing and closer escaping cannot distort
	// the source coordinates reported by truncation metadata.
	let budget = Math.max(1, Math.floor((escapedRoom * CLOSER_RAW_BYTES) / CLOSER_ESCAPED_BYTES));
	const headBytes = settingNumber(settings, "tools.artifactHeadBytes") * 1024;
	const tailLines = settingNumber(settings, "tools.artifactTailLines");
	const headBudget = Math.max(
		1,
		Math.floor((Math.min(headBytes, escapedRoom / 2) * CLOSER_RAW_BYTES) / CLOSER_ESCAPED_BYTES),
	);
	const cutRemoteOutput = (maxBytes: number) => {
		if (headBytes > 0) {
			const options = {
				maxBytes,
				maxLines: tailLines * 2,
				maxHeadBytes: Math.min(headBudget, Math.floor(maxBytes / 2)),
				maxHeadLines: tailLines,
			};
			return {
				truncation: truncateMiddle(output, options),
				windows: truncateMiddleWindows(output, options),
			};
		}
		const options = { maxBytes, maxLines: tailLines };
		return {
			truncation: truncateTail(output, options),
			windows: truncateMiddleWindows(output, { ...options, maxHeadBytes: 0, maxHeadLines: 0 }),
		};
	};
	let { truncation, windows } = cutRemoteOutput(budget);
	let excerpt = truncation.truncated ? truncation.content : output;
	let text = wrapUntrustedContent(excerpt);
	let textBytes = Buffer.byteLength(text, "utf-8");
	while (textBytes > cap && budget > 1) {
		const scaledBudget = Math.floor((budget * cap) / textBytes);
		budget = Math.max(1, Math.min(budget - 1, scaledBudget));
		({ truncation, windows } = cutRemoteOutput(budget));
		excerpt = truncation.truncated ? truncation.content : output;
		text = wrapUntrustedContent(excerpt);
		textBytes = Buffer.byteLength(text, "utf-8");
	}
	if (text === wrapUntrustedContent(output)) return frameFullRemoteOutput(output);
	if (windows.kind === "full") return frameFullRemoteOutput(output);
	const direction = windows.kind === "middle" ? "middle" : windows.kind === "head-only" ? "head" : "tail";
	return {
		text,
		truncation,
		direction,
		shrunk: true,
		visibleLines: (windows.head?.lines ?? 0) + (windows.tail?.lines ?? 0),
		visibleBytes: (windows.head?.bytes ?? 0) + (windows.tail?.bytes ?? 0),
	};
}

/** Store the full remote text. Never write an already-shortened excerpt.
 * The command has already finished, so a rejected reservation must not discard it.
 */
async function storeFullRemoteOutput(
	session: ToolSession,
	output: string,
	artifactPublication: SessionArtifactPublication | undefined,
): Promise<string | undefined> {
	let allocated: { id?: string; path?: string } | undefined;
	try {
		allocated = await session.allocateOutputArtifact?.("ssh");
	} catch {
		allocated = undefined;
	}
	if (allocated?.path && allocated.id) {
		try {
			await Bun.write(allocated.path, output);
			return allocated.id;
		} catch {
			// Fall through to the session-owned publisher when a writable path failed.
		}
	}
	if (!artifactPublication) return undefined;
	try {
		return await artifactPublication(output, "ssh");
	} catch {
		return undefined;
	}
}

function createSshArtifactPublisher(
	artifactPublication: SessionArtifactPublication | undefined,
): TerminalArtifactPublisher | undefined {
	if (!artifactPublication) return undefined;
	return async (content, info) => {
		try {
			const artifactId = await artifactPublication(content, "ssh");
			if (!artifactId) return { status: "unavailable" };
			return info.omittedBytes > 0
				? { status: "published", artifactId, omittedBytes: info.omittedBytes }
				: { status: "published", artifactId };
		} catch (error) {
			return { status: "failed", diagnostic: error instanceof Error ? error.message : String(error) };
		}
	};
}

function hasCompleteRemoteOutput(result: SSHResult, output: string): boolean {
	return (
		!result.truncated &&
		result.outputBytes === result.totalBytes &&
		Buffer.byteLength(output, "utf-8") === result.outputBytes
	);
}

function incompleteOutputNotice(result: SSHResult, artifactId: string | undefined): string | undefined {
	const retainedWindowIncomplete = result.truncated || result.outputBytes < result.totalBytes;
	if (!retainedWindowIncomplete) return undefined;

	const artifactIncomplete =
		(result.artifactTruncatedBytes ?? 0) > 0 || result.artifactFailureDiagnostic !== undefined;
	const completeArtifactAvailable = artifactId !== undefined && !artifactIncomplete;
	if (completeArtifactAvailable) return undefined;

	const notes = [`SSH output is incomplete: retained ${result.outputBytes} of ${result.totalBytes} bytes`];
	notes.push("no complete output artifact is available");
	if ((result.artifactTruncatedBytes ?? 0) > 0) {
		notes.push(`artifact storage omitted at least ${result.artifactTruncatedBytes} bytes`);
	}
	if (result.artifactFailureDiagnostic) {
		notes.push(`Artifact storage failed: ${result.artifactFailureDiagnostic}`);
	}
	return notes.join("; ");
}

function buildRemoteCommand(command: string, cwd: string | undefined, info: SSHHostInfo): string {
	if (!cwd) return command;

	if (info.os === "windows" && !info.compatEnabled) {
		if (info.shell === "powershell") {
			return `Set-Location -Path ${quotePowerShellPath(cwd)}; ${command}`;
		}
		return `cd /d ${quoteCmdPath(cwd)} && ${command}`;
	}

	return `cd -- ${quoteRemotePath(cwd)} && ${command}`;
}

async function loadHosts(session: ToolSession): Promise<{
	hostNames: string[];
	hostsByName: Map<string, SSHHost>;
}> {
	const result = await loadCapability<SSHHost>(sshCapability.id, { cwd: session.cwd, settings: session.settings });
	const hostsByName = new Map<string, SSHHost>();
	for (const host of result.items) {
		if (!hostsByName.has(host.name)) {
			hostsByName.set(host.name, host);
		}
	}
	const hostNames = Array.from(hostsByName.keys()).sort();
	return { hostNames, hostsByName };
}

type SshToolParams = z.infer<typeof sshSchema>;

export class SshTool implements AgentTool<typeof sshSchema, SSHToolDetails> {
	readonly name = "ssh";
	readonly summary = "Execute a command on a remote host over SSH";
	readonly loadMode = "discoverable";
	readonly label = "SSH";
	readonly parameters = sshSchema;
	readonly concurrency = "exclusive";
	readonly strict = true;

	readonly #allowedHosts: Set<string>;

	constructor(
		private readonly session: ToolSession,
		private readonly hostNames: string[],
		private readonly hostsByName: Map<string, SSHHost>,
		readonly description: string,
	) {
		this.#allowedHosts = new Set(this.hostNames);
	}

	async execute(
		_toolCallId: string,
		{ host, command, cwd, timeout: rawTimeout = 60 }: SshToolParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<SSHToolDetails>,
		_ctx?: AgentToolContext,
	): Promise<AgentToolResult<SSHToolDetails>> {
		if (!this.#allowedHosts.has(host)) {
			throw new ToolError(`Unknown SSH host: ${host}. Available hosts: ${this.hostNames.join(", ")}`);
		}

		const hostConfig = this.hostsByName.get(host);
		if (!hostConfig) {
			throw new ToolError(`SSH host not loaded: ${host}`);
		}

		const hostInfo = await ensureHostInfo(hostConfig);
		const remoteCommand = buildRemoteCommand(command, cwd, hostInfo);

		// Clamp to reasonable range: 1s - 3600s (1 hour)
		const timeoutSec = clampTimeout("ssh", rawTimeout);
		const timeoutMs = timeoutSec * 1000;
		const outputSettings = _ctx?.settings ?? this.session.settings;
		const artifactPublication = this.session.captureArtifactPublication?.();

		const tailBuffer = new TailBuffer(DEFAULT_MAX_BYTES);
		const { path: artifactPath, id: artifactId } = (await this.session.allocateOutputArtifact?.("ssh")) ?? {};

		const result = await executeSSH(hostConfig, remoteCommand, {
			settings: this.session.settings,
			timeout: timeoutMs,
			signal,
			compatEnabled: hostInfo.compatEnabled,
			artifactPath,
			artifactId,
			artifactPublisher: createSshArtifactPublisher(artifactPublication),
			onChunk: streamTailUpdates(tailBuffer, onUpdate),
		});

		const remote = result.output ?? "";
		let storedArtifactId = result.artifactId;
		let framed: RemoteFrame | undefined;
		if (!remote) {
			framed = undefined;
		} else if (!exceedsInlineCap(remote, outputSettings)) {
			framed = frameFullRemoteOutput(remote);
		} else {
			if (!storedArtifactId && hasCompleteRemoteOutput(result, remote)) {
				storedArtifactId = await storeFullRemoteOutput(this.session, remote, artifactPublication);
			}
			framed = storedArtifactId ? frameShrunkRemoteOutput(remote, outputSettings) : frameFullRemoteOutput(remote);
		}
		// The artifact id stays in truncation metadata. A line after the closing
		// fence makes the inline backstop drop the opening fence.
		const modelText = framed?.text;
		const storedNote =
			(framed?.shrunk || result.truncated) && storedArtifactId
				? `\n\n${formatArtifactReference(storedArtifactId, result.artifactTruncatedBytes)}`
				: "";
		const incompleteNote = incompleteOutputNotice(result, storedArtifactId);
		const artifactFailureNote =
			result.artifactFailureDiagnostic && !incompleteNote
				? `SSH streaming artifact storage failed: ${result.artifactFailureDiagnostic}`
				: undefined;
		if (result.cancelled) {
			const message = [
				modelText || "Command aborted",
				storedNote.trim() || undefined,
				incompleteNote,
				artifactFailureNote,
			]
				.filter((part): part is string => part !== undefined)
				.join("\n\n");
			throw new ToolError(message);
		}

		const outputText = modelText ?? "(no output)";
		const details: SSHToolDetails = {};
		const resultBuilder = toolResult(details).text(outputText);
		if (framed?.shrunk && framed.truncation && storedArtifactId) {
			resultBuilder.truncation(framed.truncation, {
				direction: framed.direction ?? "tail",
				artifactId: storedArtifactId,
			});
		} else {
			resultBuilder.truncationFromSummary(result, { direction: "tail" });
		}

		if (result.exitCode !== 0 && result.exitCode !== undefined) {
			const message = [
				outputText,
				storedNote.trim() || undefined,
				incompleteNote,
				artifactFailureNote,
				`Command exited with code ${result.exitCode}`,
			]
				.filter((part): part is string => part !== undefined)
				.join("\n\n");
			throw new ToolError(message);
		}

		const built = resultBuilder.done();
		const truncation = built.details?.meta?.truncation;
		if (framed?.shrunk && truncation) {
			// The cut is a window of an earlier excerpt. Keep the stream totals
			// and do not present that window's coordinates as the original range.
			truncation.totalLines = result.totalLines;
			truncation.totalBytes = result.totalBytes;
			truncation.outputLines = framed.visibleLines;
			truncation.outputBytes = framed.visibleBytes;
			truncation.artifactId = storedArtifactId;
			truncation.artifactTruncatedBytes = result.artifactTruncatedBytes;
			truncation.artifactFailureDiagnostic = result.artifactFailureDiagnostic;
			delete truncation.shownRange;
			delete truncation.headRange;
			delete truncation.tailRange;
			delete truncation.nextOffset;
			if (framed.direction === "middle") {
				truncation.elidedLines = Math.max(0, result.totalLines - framed.visibleLines);
				truncation.elidedBytes = Math.max(0, result.totalBytes - framed.visibleBytes);
			}
		}
		return built;
	}
}

export async function loadSshTool(session: ToolSession): Promise<SshTool | null> {
	const { hostNames, hostsByName } = await loadHosts(session);
	if (hostNames.length === 0) {
		return null;
	}

	const descriptionHosts = hostNames
		.map(name => hostsByName.get(name))
		.filter((host): host is SSHHost => host !== undefined);
	const description = await formatDescription(descriptionHosts);

	return new SshTool(session, hostNames, hostsByName, description);
}

// =============================================================================
// TUI Renderer
// =============================================================================

interface SshRenderArgs {
	host?: string;
	command?: string;
	timeout?: number;
}

interface SshRenderContext {
	/** Visual lines for truncated output (pre-computed by tool-execution) */
	visualLines?: string[];
	/** Number of lines skipped */
	skippedCount?: number;
	/** Total visual lines */
	totalVisualLines?: number;
}

export const sshToolRenderer = {
	renderCall(args: SshRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const host = args.host || "…";
		const command = args.command || "…";
		const text = renderStatusLine({ icon: "pending", title: "SSH", description: `[${host}] $ ${command}` }, uiTheme);
		return new Text(text, 0, 0);
	},

	renderResult(
		result: {
			content: Array<{ type: string; text?: string }>;
			details?: SSHToolDetails;
		},
		options: RenderResultOptions & { renderContext?: SshRenderContext },
		uiTheme: Theme,
		args?: SshRenderArgs,
	): Component {
		const details = result.details;
		const host = args?.host || "…";
		const command = args?.command || "…";
		const header = renderStatusLine(
			{ icon: "success", title: "SSH", description: `[${host}] $ ${command}` },
			uiTheme,
		);
		const textContent = result.content?.find(c => c.type === "text")?.text ?? "";
		const outputBlock = new CachedOutputBlock();

		return {
			render: (width: number): string[] => {
				// REACTIVE: read mutable options at render time
				const { expanded, renderContext } = options;
				// Strip LLM-facing notice so we don't echo it next to the styled warning.
				const output = stripOutputNotice(textContent, details?.meta).trimEnd();
				const outputLines: string[] = [];

				if (output) {
					if (expanded) {
						outputLines.push(...output.split("\n").map(line => uiTheme.fg("toolOutput", line)));
					} else if (renderContext?.visualLines) {
						const { visualLines, skippedCount = 0, totalVisualLines = visualLines.length } = renderContext;
						if (skippedCount > 0) {
							outputLines.push(
								uiTheme.fg(
									"dim",
									`… (${skippedCount} earlier lines, showing ${visualLines.length} of ${totalVisualLines}) (ctrl+o to expand)`,
								),
							);
						}
						const styledVisual = visualLines.map(line =>
							line.includes("\x1b[") ? line : uiTheme.fg("toolOutput", line),
						);
						outputLines.push(...styledVisual);
					} else {
						const outputLinesRaw = output.split("\n");
						const maxLines = 5;
						const displayLines = outputLinesRaw.slice(0, maxLines);
						const remaining = outputLinesRaw.length - maxLines;
						outputLines.push(...displayLines.map(line => uiTheme.fg("toolOutput", line)));
						if (remaining > 0) {
							outputLines.push(uiTheme.fg("dim", `… (${remaining} more lines) (ctrl+o to expand)`));
						}
					}
				}

				if (details?.meta?.truncation) {
					const warning = formatStyledTruncationWarning(details.meta, uiTheme);
					if (warning) outputLines.push(warning);
				}

				return outputBlock.render(
					{
						header,
						state: "success",
						sections: [{ label: uiTheme.fg("toolTitle", "Output"), lines: outputLines }],
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
};
