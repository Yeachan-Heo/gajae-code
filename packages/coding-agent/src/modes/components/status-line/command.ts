const DEFAULT_TIMEOUT_MS = 500;
const MIN_TIMEOUT_MS = 50;
const MAX_TIMEOUT_MS = 10_000;
const DEFAULT_REFRESH_MS = 5_000;
const MIN_REFRESH_MS = 250;
const MAX_REFRESH_MS = 60_000;
export const STATUS_LINE_COMMAND_DEFAULT_MAX_LENGTH = 80;
export const STATUS_LINE_COMMAND_MAX_LENGTH = 256;
const STATUS_LINE_COMMAND_MAX_OUTPUT_BYTES = 16 * 1024;
const STATUS_LINE_COMMAND_MAX_DIAGNOSTIC_BYTES = 1_024;

export interface StatusLineCommandOptions {
	command?: string;
	timeoutMs?: number;
	refreshMs?: number;
	maxLength?: number;
}

export interface ResolvedStatusLineCommandOptions {
	command: string;
	timeoutMs: number;
	refreshMs: number;
	maxLength: number;
}

export interface StatusLineCommandResult {
	stdout: string;
	stderr: string;
	exitCode: number;
	timedOut: boolean;
	outputTruncated: boolean;
}

interface BoundedReadResult {
	text: string;
	truncated: boolean;
}

function finiteNumber(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, Math.trunc(finiteNumber(value, fallback))));
}

export function normalizeStatusLineCommandOptions(value: unknown): ResolvedStatusLineCommandOptions {
	const record = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
	return {
		command: typeof record.command === "string" ? record.command.trim() : "",
		timeoutMs: clampInteger(record.timeoutMs, DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS),
		refreshMs: clampInteger(record.refreshMs, DEFAULT_REFRESH_MS, MIN_REFRESH_MS, MAX_REFRESH_MS),
		maxLength: clampInteger(
			record.maxLength,
			STATUS_LINE_COMMAND_DEFAULT_MAX_LENGTH,
			1,
			STATUS_LINE_COMMAND_MAX_LENGTH,
		),
	};
}

async function readBounded(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<BoundedReadResult> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let retainedBytes = 0;
	let truncated = false;

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!(value instanceof Uint8Array)) continue;
			if (retainedBytes >= maxBytes) {
				truncated = true;
				continue;
			}
			const remaining = maxBytes - retainedBytes;
			const retained = value.byteLength <= remaining ? value : value.slice(0, remaining);
			chunks.push(retained);
			retainedBytes += retained.byteLength;
			if (retained.byteLength < value.byteLength) truncated = true;
		}
	} finally {
		reader.releaseLock();
	}

	const bytes = new Uint8Array(retainedBytes);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { text: new TextDecoder().decode(bytes), truncated };
}

function boundedDiagnostic(text: string): string {
	return text.replace(/\s+/gu, " ").trim().slice(0, STATUS_LINE_COMMAND_MAX_DIAGNOSTIC_BYTES);
}

/**
 * Run a configured status-line command without making the synchronous render
 * path wait on it. The streams are drained with a hard byte cap and the whole
 * process group is killed when the timeout expires.
 */
export async function runStatusLineCommand(
	command: string,
	options: {
		cwd: string;
		shell: string;
		shellArgs: readonly string[];
		env: Record<string, string>;
		timeoutMs: number;
		signal?: AbortSignal;
	},
): Promise<StatusLineCommandResult> {
	const proc = Bun.spawn([options.shell, ...options.shellArgs, command], {
		cwd: options.cwd,
		env: options.env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		detached: process.platform !== "win32",
		...(process.platform === "win32" ? { windowsHide: true } : {}),
	});

	let timedOut = false;
	let termination: Promise<void> | undefined;
	const terminateProcessTree = async (): Promise<void> => {
		if (process.platform === "win32" && proc.pid) {
			try {
				const taskkill = Bun.spawn(["taskkill", "/pid", String(proc.pid), "/t", "/f"], {
					stdout: "ignore",
					stderr: "ignore",
					windowsHide: true,
				});
				await taskkill.exited;
				return;
			} catch {
				// Fall through to the direct kill if taskkill is unavailable.
			}
		}
		try {
			if (process.platform !== "win32" && proc.pid) process.kill(-proc.pid, "SIGKILL");
			else proc.kill();
		} catch {
			try {
				proc.kill();
			} catch {
				// The process already exited.
			}
		}
	};
	const terminate = (): void => {
		termination ??= terminateProcessTree();
	};
	let aborted = false;
	const onAbort = (): void => {
		aborted = true;
		terminate();
	};
	if (options.signal?.aborted) onAbort();
	else options.signal?.addEventListener("abort", onAbort, { once: true });
	const timeout = setTimeout(() => {
		timedOut = true;
		terminate();
	}, options.timeoutMs);

	try {
		const exitCodePromise = proc.exited.then(async exitCode => {
			if (termination) await termination;
			return exitCode;
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			readBounded(proc.stdout, STATUS_LINE_COMMAND_MAX_OUTPUT_BYTES),
			readBounded(proc.stderr, STATUS_LINE_COMMAND_MAX_DIAGNOSTIC_BYTES),
			exitCodePromise,
		]);
		if (termination) await termination;
		return {
			stdout: stdout.text,
			stderr: boundedDiagnostic(stderr.text),
			exitCode: exitCode ?? 1,
			timedOut: timedOut || aborted,
			outputTruncated: stdout.truncated,
		};
	} finally {
		clearTimeout(timeout);
		options.signal?.removeEventListener("abort", onAbort);
	}
}
