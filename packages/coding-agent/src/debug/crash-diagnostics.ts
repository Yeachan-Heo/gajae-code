import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const CRASH_DIAGNOSTICS_ENV = "GJC_CRASH_DIAGNOSTICS";
const CRASH_DIAGNOSTICS_DIR_ENV = "GJC_CRASH_DIAGNOSTICS_DIR";
const STDERR_PREVIEW_BYTES = 4096;
const DIRECTORY_MODE = 0o700;
const REPORT_FILE_MODE = 0o600;

export type CrashProcessKind = "bash" | "python" | "lsp" | "dap" | "mcp" | "browser" | "worker" | "native" | "unknown";

export type CrashClass =
	| "clean_exit"
	| "non_zero_exit"
	| "signal_exit"
	| "timeout"
	| "cancelled"
	| "spawn_error"
	| "protocol_exit"
	| "native_panic"
	| "unknown";

export interface CrashClassificationInput {
	kind: CrashProcessKind;
	command?: string[];
	exitCode?: number | null;
	signal?: string | null;
	cancelled?: boolean;
	timedOut?: boolean;
	spawnError?: unknown;
	stderr?: string;
	protocol?: string;
}

export interface CrashClassification {
	kind: CrashProcessKind;
	class: CrashClass;
	crashed: boolean;
	exitCode: number | null;
	signal: string | null;
	command?: string[];
	protocol?: string;
	reason: string;
}

export interface CrashReport extends CrashClassification {
	schemaVersion: 1;
	createdAt: string;
	pid: number;
	cwd: string;
	stderrPreview?: string;
	spawnError?: string;
}

export interface CrashReportWriteResult {
	report: CrashReport;
	path: string | null;
	enabled: boolean;
}

export function crashDiagnosticsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const value = env[CRASH_DIAGNOSTICS_ENV];
	return value === "1" || value === "true" || value === "yes";
}

export function getCrashDiagnosticsDirectory(env: NodeJS.ProcessEnv = process.env): string {
	return env[CRASH_DIAGNOSTICS_DIR_ENV] ?? path.join(os.tmpdir(), "gjc-crash-diagnostics");
}

export function classifyProcessCrash(input: CrashClassificationInput): CrashClassification {
	const exitCode = input.exitCode ?? null;
	const signal = input.signal ?? null;
	const command = input.command;
	const protocol = input.protocol;

	if (input.timedOut) {
		return {
			kind: input.kind,
			class: "timeout",
			crashed: true,
			exitCode,
			signal,
			command,
			protocol,
			reason: "process timed out",
		};
	}
	if (input.cancelled) {
		return {
			kind: input.kind,
			class: "cancelled",
			crashed: false,
			exitCode,
			signal,
			command,
			protocol,
			reason: "process was cancelled",
		};
	}
	if (input.spawnError !== undefined) {
		return {
			kind: input.kind,
			class: "spawn_error",
			crashed: true,
			exitCode,
			signal,
			command,
			protocol,
			reason: stringifyError(input.spawnError),
		};
	}
	if (signal) {
		return {
			kind: input.kind,
			class: "signal_exit",
			crashed: true,
			exitCode,
			signal,
			command,
			protocol,
			reason: `process exited after signal ${signal}`,
		};
	}
	if (exitCode === 0) {
		return {
			kind: input.kind,
			class: "clean_exit",
			crashed: false,
			exitCode,
			signal,
			command,
			protocol,
			reason: "process exited cleanly",
		};
	}
	if (exitCode !== null) {
		return {
			kind: input.kind,
			class: "non_zero_exit",
			crashed: true,
			exitCode,
			signal,
			command,
			protocol,
			reason: `process exited with code ${exitCode}`,
		};
	}
	return {
		kind: input.kind,
		class: "protocol_exit",
		crashed: true,
		exitCode,
		signal,
		command,
		protocol,
		reason: "process exited before protocol completion",
	};
}

export async function writeCrashReport(
	input: CrashClassificationInput,
	options: { cwd?: string; env?: NodeJS.ProcessEnv; now?: Date } = {},
): Promise<CrashReportWriteResult> {
	const classification = classifyProcessCrash(input);
	const report: CrashReport = {
		schemaVersion: 1,
		createdAt: (options.now ?? new Date()).toISOString(),
		pid: process.pid,
		cwd: options.cwd ?? process.cwd(),
		...classification,
		stderrPreview: input.stderr ? trimStartBytes(input.stderr, STDERR_PREVIEW_BYTES) : undefined,
		spawnError: input.spawnError === undefined ? undefined : stringifyError(input.spawnError),
	};
	const enabled = crashDiagnosticsEnabled(options.env);

	if (!classification.crashed || !enabled) {
		return { report, path: null, enabled };
	}

	try {
		const dir = getCrashDiagnosticsDirectory(options.env);
		await ensurePrivateDiagnosticsDirectory(dir);
		const filename = `${report.createdAt.replace(/[:.]/g, "-")}-${report.kind}-${report.class}-${process.pid}.json`;
		const reportPath = path.join(dir, filename);
		await writePrivateCrashReport(reportPath, `${JSON.stringify(report, null, 2)}\n`);
		return { report, path: reportPath, enabled };
	} catch {
		return { report, path: null, enabled };
	}
}

export function formatCrashDiagnosticNotice(result: CrashReportWriteResult): string | null {
	if (!result.report.crashed || !result.enabled) return null;
	const location = result.path ? ` report=${result.path}` : "";
	return `[crash:${result.report.kind}:${result.report.class}] ${result.report.reason}${location}`;
}

async function ensurePrivateDiagnosticsDirectory(dir: string): Promise<void> {
	await fs.mkdir(dir, { recursive: true, mode: DIRECTORY_MODE });
	await fs.chmod(dir, DIRECTORY_MODE);
}

async function writePrivateCrashReport(reportPath: string, contents: string): Promise<void> {
	const file = await fs.open(reportPath, "wx", REPORT_FILE_MODE);
	try {
		await file.writeFile(contents);
	} finally {
		await file.close();
	}
	await fs.chmod(reportPath, REPORT_FILE_MODE);
}

function stringifyError(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

function trimStartBytes(value: string, maxBytes: number): string {
	const bytes = Buffer.from(value);
	if (bytes.byteLength <= maxBytes) return value;
	return Buffer.from(bytes.subarray(bytes.byteLength - maxBytes)).toString("utf8");
}
