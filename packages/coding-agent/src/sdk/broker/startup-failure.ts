import * as fs from "node:fs/promises";
import * as path from "node:path";
import { processIncarnation } from "./process-incarnation";

export interface BrokerStartupFailureMarker {
	version: 2;
	reason: string;
	exitCode: number | null;
	signal: string | null;
	writtenAt: number;
	/**
	 * pid of the exact broker process that wrote this marker. `ensureBroker`
	 * only trusts a marker whose pid matches the exact spawned child it just
	 * reaped -- a marker left behind by a stale or foreign broker process (for
	 * example a losing racer from a concurrent spawn, or a marker predating the
	 * pre-spawn clear) must never be misattributed to a different spawn's
	 * failure.
	 */
	pid: number;
	/** Kernel-derived identity for the exact process incarnation that wrote the marker. */
	incarnation: string;
}

const BROKER_STARTUP_FAILURE_FILE = "broker.startup-failure.json";
const MAX_BROKER_STARTUP_FAILURE_REASON = 512;
const FILE_LOCK_CLEANUP_GUIDANCE =
	"; manual cleanup is appropriate only after independently verifying this exact directory still belongs to the dead owner and no successor has taken it: ";
const FILE_LOCK_OWNER_GUIDANCE =
	"; a live owner is never displaced — if this is an SDK broker (gjc sdk session list), it must finish or be stopped before retrying";
const COMPACT_FILE_LOCK_CLEANUP_GUIDANCE =
	"Manual cleanup is appropriate only after independently verifying this exact directory still belongs to the dead owner and no successor has taken it: ";

function decodeFileLockCleanupCommand(command: string): string | undefined {
	const prefix = process.platform === "win32" ? "Remove-Item -LiteralPath '" : "rm -rf -- '";
	const suffix = process.platform === "win32" ? "' -Recurse -Force" : "'";
	if (!command.startsWith(prefix) || !command.endsWith(suffix)) return undefined;

	const encodedPath = command.slice(prefix.length, -suffix.length);
	const quoteEscape = process.platform === "win32" ? "''" : "'\\''";
	const decodedPath = encodedPath.replaceAll(quoteEscape, "'");
	if (!decodedPath || decodedPath.replaceAll("'", quoteEscape) !== encodedPath) return undefined;
	return decodedPath;
}

function boundedReason(reason: string): string {
	if (reason.length <= MAX_BROKER_STARTUP_FAILURE_REASON) return reason;

	let guidanceIndex = reason.indexOf(FILE_LOCK_CLEANUP_GUIDANCE);
	while (guidanceIndex >= 0) {
		const command = reason.slice(guidanceIndex + FILE_LOCK_CLEANUP_GUIDANCE.length);
		const lockPath = decodeFileLockCleanupCommand(command);
		if (lockPath) {
			const beforeCleanup = reason.slice(0, guidanceIndex);
			const lockAndOwnerGuidance = ` (${lockPath})${FILE_LOCK_OWNER_GUIDANCE}`;
			const acquisition = beforeCleanup.endsWith(lockAndOwnerGuidance)
				? beforeCleanup.slice(0, -lockAndOwnerGuidance.length)
				: "";
			if (/^Failed to acquire lock for [\s\S]+ after \d+ attempts: [\s\S]+$/.test(acquisition)) {
				const compactReason = `${COMPACT_FILE_LOCK_CLEANUP_GUIDANCE}${command}`;
				if (compactReason.length <= MAX_BROKER_STARTUP_FAILURE_REASON) return compactReason;
			}
		}
		guidanceIndex = reason.indexOf(FILE_LOCK_CLEANUP_GUIDANCE, guidanceIndex + 1);
	}

	return reason.slice(0, MAX_BROKER_STARTUP_FAILURE_REASON);
}

export function brokerStartupFailurePath(agentDir: string): string {
	return path.join(agentDir, "sdk", BROKER_STARTUP_FAILURE_FILE);
}

function boundedMarker(
	reason: string,
	exitCode: number | null,
	signal: string | null,
	pid: number,
	incarnation: string,
): BrokerStartupFailureMarker {
	return {
		version: 2,
		reason: boundedReason(reason),
		exitCode,
		signal,
		writtenAt: Date.now(),
		pid,
		incarnation,
	};
}

/**
 * Best-effort durable marker write; never throws (diagnostics must not mask the
 * exit itself). `pid` must be the writing broker process's own pid
 * (`process.pid`) so a later reader can bind the marker to the exact spawned
 * child it is attributing the failure to.
 */
export async function writeBrokerStartupFailureMarker(
	agentDir: string,
	failure: { reason: string; exitCode: number | null; signal: string | null; pid: number; incarnation?: string },
): Promise<void> {
	try {
		const incarnation = failure.incarnation ?? processIncarnation(failure.pid);
		if (!incarnation) return;
		await fs.mkdir(path.dirname(brokerStartupFailurePath(agentDir)), { recursive: true, mode: 0o700 });
		await Bun.write(
			brokerStartupFailurePath(agentDir),
			JSON.stringify(boundedMarker(failure.reason, failure.exitCode, failure.signal, failure.pid, incarnation)),
		);
	} catch {
		// Best-effort only.
	}
}

/** Reads a bounded startup-failure marker; `undefined` when absent or malformed. */
export async function readBrokerStartupFailureMarker(
	agentDir: string,
): Promise<BrokerStartupFailureMarker | undefined> {
	try {
		const file = Bun.file(brokerStartupFailurePath(agentDir));
		if (!(await file.exists())) return undefined;
		const raw = await file.text();
		const value: unknown = JSON.parse(raw);
		if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
		const marker = value as Partial<BrokerStartupFailureMarker>;
		if (
			marker.version !== 2 ||
			typeof marker.reason !== "string" ||
			marker.reason.length === 0 ||
			(marker.exitCode !== null && typeof marker.exitCode !== "number") ||
			(marker.signal !== null && typeof marker.signal !== "string") ||
			typeof marker.writtenAt !== "number" ||
			typeof marker.pid !== "number" ||
			!Number.isInteger(marker.pid) ||
			marker.pid <= 0 ||
			typeof marker.incarnation !== "string" ||
			marker.incarnation.length === 0
		)
			return undefined;
		return marker as BrokerStartupFailureMarker;
	} catch {
		return undefined;
	}
}

/** Best-effort marker removal; used at spawn so a stale marker never misattributes an older failure. */
export async function clearBrokerStartupFailureMarker(agentDir: string): Promise<void> {
	try {
		const file = Bun.file(brokerStartupFailurePath(agentDir));
		if (await file.exists()) await file.unlink();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			// Best-effort only.
		}
	}
}

/** Typed error returned when a detached broker exits before discovery. */
export class BrokerStartupError extends Error {
	readonly code = "broker_startup_failed";
	readonly exitCode: number | null;
	readonly signal: string | null;
	readonly reason: string;
	readonly stderrExcerpt?: string;

	constructor(fields: { exitCode: number | null; signal: string | null; reason: string; stderrExcerpt?: string }) {
		super(
			`Detached SDK broker exited before discovery (code=${fields.exitCode}, signal=${fields.signal}): ${fields.reason}${fields.stderrExcerpt ? ` Broker stderr: ${fields.stderrExcerpt}` : ""}`,
		);
		this.name = "BrokerStartupError";
		this.exitCode = fields.exitCode;
		this.signal = fields.signal;
		this.reason = fields.reason;
		this.stderrExcerpt = fields.stderrExcerpt;
	}
}
