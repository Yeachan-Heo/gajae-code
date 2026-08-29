import { logger, ptree } from "@gajae-code/utils";
import { Settings } from "../config/settings";
import { OutputSink } from "../session/streaming-output";
import { resolveOutputMaxColumns, resolveOutputSinkHeadBytes } from "../tools/output-meta";
import { buildRemoteCommand, ensureConnection, ensureHostInfo, type SSHConnectionTarget } from "./connection-manager";
import { hasSshfs, mountRemote } from "./sshfs-mount";

export interface SSHExecutorOptions {
	/** Session settings used for output policy. */
	settings?: Settings;
	/** Timeout in milliseconds */
	timeout?: number;
	/** Callback for streaming output chunks (already sanitized) */
	onChunk?: (chunk: string) => void;
	/** AbortSignal for cancellation */
	signal?: AbortSignal;
	/** Remote path to mount when sshfs is available */
	remotePath?: string;
	/** Wrap commands in a POSIX shell for compat mode */
	compatEnabled?: boolean;
	/** Artifact path/id for full output storage */
	artifactPath?: string;
	artifactId?: string;
}

export interface SSHResult {
	/** Combined stdout + stderr output (sanitized, possibly truncated) */
	output: string;
	/** Process exit code (undefined if killed/cancelled) */
	exitCode: number | undefined;
	/** Whether the command was cancelled via signal */
	cancelled: boolean;
	/** Whether the output was truncated */
	truncated: boolean;
	/** Total number of lines in the output stream */
	totalLines: number;
	/** Total number of bytes in the output stream */
	totalBytes: number;
	/** Number of lines included in the output text */
	outputLines: number;
	/** Number of bytes included in the output text */
	outputBytes: number;
	/** Artifact ID if full output was saved to artifact storage */
	artifactId?: string;
}

function quoteForCompatShell(command: string): string {
	if (command.length === 0) {
		return "''";
	}
	const escaped = command.replace(/'/g, "'\\''");
	return `'${escaped}'`;
}

function buildCompatCommand(shell: "bash" | "sh", command: string): string {
	return `${shell} -c ${quoteForCompatShell(command)}`;
}

export async function executeSSH(
	host: SSHConnectionTarget,
	command: string,
	options?: SSHExecutorOptions,
): Promise<SSHResult> {
	await ensureConnection(host);
	if (hasSshfs()) {
		try {
			await mountRemote(host, options?.remotePath ?? "/");
		} catch (err) {
			logger.warn("SSHFS mount failed", { host: host.name, error: String(err) });
		}
	}

	let resolvedCommand = command;
	if (options?.compatEnabled) {
		const info = await ensureHostInfo(host);
		if (info.compatShell) {
			resolvedCommand = buildCompatCommand(info.compatShell, command);
		} else {
			logger.warn("SSH compat enabled without detected compat shell", { host: host.name });
		}
	}

	using child = ptree.spawn(["ssh", ...(await buildRemoteCommand(host, resolvedCommand))], {
		signal: options?.signal,
		timeout: options?.timeout,
		stdin: "pipe",
		stderr: "full",
	});

	const settings = options?.settings ?? (await Settings.currentOrInit());
	const sink = new OutputSink({
		onChunk: options?.onChunk,
		artifactPath: options?.artifactPath,
		artifactId: options?.artifactId,
		headBytes: resolveOutputSinkHeadBytes(settings),
		maxColumns: resolveOutputMaxColumns(settings),
	});

	const streams = [child.stdout.pipeTo(sink.createInput())];
	if (child.stderr) {
		streams.push(child.stderr.pipeTo(sink.createInput()));
	}
	await Promise.allSettled(streams).catch(() => {});

	try {
		return {
			exitCode: await child.exited,
			cancelled: false,
			...(await sink.dump()),
		};
	} catch (err) {
		if (err instanceof ptree.Exception) {
			if (err instanceof ptree.TimeoutError) {
				return {
					exitCode: undefined,
					cancelled: true,
					...(await sink.dump(`SSH: ${err.message}`)),
				};
			}
			if (err.aborted) {
				return {
					exitCode: undefined,
					cancelled: true,
					...(await sink.dump(`Command aborted: ${err.message}`)),
				};
			}
			return {
				exitCode: err.exitCode,
				cancelled: false,
				...(await sink.dump(`Unexpected error: ${err.message}`)),
			};
		}
		throw err;
	}
}
