import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { DoctorContext } from "./context";
import { doctorMapping } from "./files";
import type { DoctorProbeKind, DoctorProbeReceipt } from "./probe-types";

const PROBE_OUTPUT_LIMIT = 64 * 1024;
const PROBE_ENV_KEYS = [
	"PATH",
	"HOME",
	"USERPROFILE",
	"SYSTEMROOT",
	"WINDIR",
	"TMPDIR",
	"TEMP",
	"TMP",
	"LANG",
	"LC_ALL",
	"TZ",
	"GJC_CONFIG_DIR",
	"PI_CONFIG_DIR",
	"GJC_CODING_AGENT_DIR",
	"PI_CODING_AGENT_DIR",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_STATE_HOME",
	"XDG_CACHE_HOME",
] as const;

export interface DoctorProbeResult {
	readonly status: "completed" | "failed" | "timeout" | "cancelled";
	readonly reasonCode: string;
	readonly receipt?: DoctorProbeReceipt;
}

function probeEnvironment(): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = { NO_COLOR: "1", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" };
	for (const key of PROBE_ENV_KEYS) {
		const value = process.env[key];
		if (value !== undefined) environment[key] = value;
	}
	return environment;
}

async function readBoundedStream(stream: ReadableStream<Uint8Array>): Promise<string> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const result = await reader.read();
			if (result.done) break;
			size += result.value.byteLength;
			if (size > PROBE_OUTPUT_LIMIT) throw new Error("probe_output_limit");
			chunks.push(result.value);
		}
	} finally {
		reader.releaseLock();
	}
	const buffer = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		buffer.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
}

function parseReceipt(text: string, kind: DoctorProbeKind): DoctorProbeReceipt | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined;
	}
	const record = doctorMapping(parsed);
	if (
		record?.schemaVersion !== 1 ||
		record.kind !== kind ||
		(record.status !== "completed" && record.status !== "failed") ||
		typeof record.reasonCode !== "string" ||
		!/^[a-z_]{1,80}$/.test(record.reasonCode) ||
		!Array.isArray(record.checks) ||
		record.checks.length > 2000
	)
		return undefined;
	const executions = new Set(["completed", "blocked", "timeout", "cancelled", "unsupported", "not_selected"]);
	const healthStates = new Set(["ok", "warning", "error", "unknown", "not_applicable"]);
	const evidenceLevels = new Set(["observed", "not_probed"]);
	const safeId = (value: unknown): value is string =>
		typeof value === "string" && value.length <= 512 && /^[a-zA-Z0-9_.:-]+$/.test(value);
	// The fixed core child is still a process boundary. Unknown states are not executable facts.
	if (
		record.checks.some(value => {
			const check = doctorMapping(value);
			return (
				!check ||
				!safeId(check.id) ||
				!safeId(check.targetId) ||
				typeof check.execution !== "string" ||
				!executions.has(check.execution) ||
				typeof check.health !== "string" ||
				!healthStates.has(check.health) ||
				typeof check.evidenceLevel !== "string" ||
				!evidenceLevels.has(check.evidenceLevel) ||
				!doctorMapping(check.evidence) ||
				!Array.isArray(check.dependsOn) ||
				check.dependsOn.length > 32 ||
				!check.dependsOn.every(safeId) ||
				!Array.isArray(check.remediationIds) ||
				check.remediationIds.length > 16 ||
				!check.remediationIds.every(safeId) ||
				(check.scope !== undefined && check.scope !== "user" && check.scope !== "project") ||
				(check.reasonCode !== undefined &&
					(typeof check.reasonCode !== "string" || !/^[a-z_]{1,80}$/.test(check.reasonCode)))
			);
		})
	)
		return undefined;
	return record as unknown as DoctorProbeReceipt;
}

/** Run a bounded child of the current product runtime, never a PATH-discovered executable. */
export async function collectDoctorProbe(context: DoctorContext, kind: DoctorProbeKind): Promise<DoctorProbeResult> {
	if (context.options.mode === "dry-run") return { status: "failed", reasonCode: "probe_not_permitted_in_preview" };
	if (context.options.signal?.aborted) return { status: "cancelled", reasonCode: "cancelled" };
	const timeoutMs = Math.min(4_000, context.deadline - performance.now());
	if (timeoutMs <= 0) return { status: "timeout", reasonCode: "deadline_exceeded" };
	const args = context.compiled
		? [process.execPath, "--internal-doctor-probe", kind]
		: [
				process.execPath,
				"--no-env-file",
				`--config=${fileURLToPath(new URL("../../sdk/broker/internal-source.bunfig.toml", import.meta.url))}`,
				context.cliPath ?? "",
				"--internal-doctor-probe",
				kind,
			];
	if (!path.isAbsolute(args[0]) || (!context.compiled && !context.cliPath))
		return { status: "failed", reasonCode: "runtime_identity_unavailable" };
	let child: Bun.Subprocess<"ignore", "pipe", "pipe">;
	try {
		child = Bun.spawn(args, {
			cwd: context.cwd,
			env: probeEnvironment(),
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
	} catch {
		return { status: "failed", reasonCode: "probe_spawn_failed" };
	}
	const interrupted = Promise.withResolvers<DoctorProbeResult>();
	let timeout: NodeJS.Timeout | undefined;
	const abort = () => interrupted.resolve({ status: "cancelled", reasonCode: "cancelled" });
	context.options.signal?.addEventListener("abort", abort, { once: true });
	timeout = setTimeout(() => interrupted.resolve({ status: "timeout", reasonCode: "probe_timeout" }), timeoutMs);
	const output = Promise.all([readBoundedStream(child.stdout), readBoundedStream(child.stderr), child.exited])
		.then(([stdout, _stderr, exitCode]): DoctorProbeResult => {
			const receipt = parseReceipt(stdout, kind);
			if (!receipt)
				return {
					status: "failed",
					reasonCode: child.signalCode ? "probe_signalled" : "probe_invalid_receipt",
				};
			return {
				status: exitCode === 0 && receipt.status === "completed" ? "completed" : "failed",
				reasonCode: receipt.reasonCode,
				receipt,
			};
		})
		.catch((): DoctorProbeResult => ({ status: "failed", reasonCode: "probe_output_unavailable" }));
	let result: DoctorProbeResult;
	try {
		result = await Promise.race([output, interrupted.promise]);
	} finally {
		clearTimeout(timeout);
		context.options.signal?.removeEventListener("abort", abort);
	}
	if (child.exitCode === null) {
		// The only killable process here is this retained, fixed core probe child.
		try {
			child.kill("SIGKILL");
			const stopped = Promise.withResolvers<void>();
			const cleanupTimer = setTimeout(() => stopped.resolve(), 1_000);
			await Promise.race([child.exited, stopped.promise]);
			clearTimeout(cleanupTimer);
		} catch {
			return { status: "failed", reasonCode: "probe_termination_unverified" };
		}
		if (child.exitCode === null && child.signalCode === null)
			return { status: "failed", reasonCode: "probe_termination_unverified" };
	}
	return result;
}
