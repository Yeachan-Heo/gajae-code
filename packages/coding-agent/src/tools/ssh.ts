import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@gajae-code/agent-core";
import type { Component } from "@gajae-code/tui";
import { Text } from "@gajae-code/tui";
import { prompt } from "@gajae-code/utils";
import * as z from "zod/v4";
import type { SSHHost } from "../capability/ssh";
import { sshCapability } from "../capability/ssh";
import { loadCapability } from "../discovery";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import sshDescriptionBase from "../prompts/tools/ssh.md" with { type: "text" };
import { DEFAULT_MAX_BYTES, streamTailUpdates, TailBuffer } from "../session/streaming-output";
import type { SSHHostInfo } from "../ssh/connection-manager";
import { ensureHostInfo, getHostInfoForHost } from "../ssh/connection-manager";
import { executeSSH } from "../ssh/ssh-executor";
import { renderStatusLine } from "../tui";
import { CachedOutputBlock } from "../tui/output-block";
import type { ToolSession } from ".";
import { formatStyledTruncationWarning, type OutputMeta, stripOutputNotice } from "./output-meta";
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
	const result = await loadCapability<SSHHost>(sshCapability.id, {
		cwd: session.cwd,
		settings: session.settings,
		agentDir: session.getSessionAgentDir?.() ?? session.settings?.getAgentDir?.(),
	});
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

		const tailBuffer = new TailBuffer(DEFAULT_MAX_BYTES);
		const { path: artifactPath, id: artifactId } = (await this.session.allocateOutputArtifact?.("ssh")) ?? {};

		const result = await executeSSH(hostConfig, remoteCommand, {
			settings: this.session.settings,
			timeout: timeoutMs,
			signal,
			compatEnabled: hostInfo.compatEnabled,
			artifactPath,
			artifactId,
			onChunk: streamTailUpdates(tailBuffer, onUpdate),
		});

		if (result.cancelled) {
			throw new ToolError(result.output || "Command aborted");
		}

		const outputText = result.output || "(no output)";
		const details: SSHToolDetails = {};
		const resultBuilder = toolResult(details).text(outputText).truncationFromSummary(result, { direction: "tail" });

		if (result.exitCode !== 0 && result.exitCode !== undefined) {
			throw new ToolError(`${outputText}\n\nCommand exited with code ${result.exitCode}`);
		}

		return resultBuilder.done();
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
