import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

export type BrokerExitMode = "owned-root" | "lost-root";
export type BrokerFenceReason = "suspect-unpublished" | "observation-ambiguous" | "heartbeat-ambiguous";
export type BrokerExitReason =
	| "ownership-fence-expired"
	| "publication-liveness-timeout"
	| "restart-committed"
	| "shutdown-request"
	| "startup-failure"
	| "signal";

export type BrokerStopRequest =
	| { kind: "shutdown-request" }
	| { kind: "startup-failure" }
	| { kind: "signal"; signal: "SIGINT" | "SIGTERM" };

export interface BrokerExitRecord {
	version: 1;
	mode: BrokerExitMode;
	reason: BrokerExitReason;
	fenceReason: BrokerFenceReason | null;
	fencedForMs: number;
	uptimeMs: number;
	pid: number;
	signal: "SIGINT" | "SIGTERM" | null;
	writtenAt: number;
}

const BROKER_EXIT_FILE = "broker.exit.json";
const MAX_BROKER_EXIT_RECORD_BYTES = 1_024;
const EXIT_REASONS = new Set<BrokerExitReason>([
	"ownership-fence-expired",
	"publication-liveness-timeout",
	"restart-committed",
	"shutdown-request",
	"startup-failure",
	"signal",
]);

export function brokerExitRecordPath(agentDir: string): string {
	return path.join(agentDir, "sdk", BROKER_EXIT_FILE);
}

function isBrokerExitRecord(value: unknown): value is BrokerExitRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Partial<BrokerExitRecord>;
	const keys = Object.keys(record).sort();
	return (
		keys.join(",") ===
			["fenceReason", "fencedForMs", "mode", "pid", "reason", "signal", "uptimeMs", "version", "writtenAt"]
				.sort()
				.join(",") &&
		record.version === 1 &&
		(record.mode === "owned-root" || record.mode === "lost-root") &&
		typeof record.reason === "string" &&
		EXIT_REASONS.has(record.reason as BrokerExitReason) &&
		(record.fenceReason === null ||
			record.fenceReason === "suspect-unpublished" ||
			record.fenceReason === "observation-ambiguous" ||
			record.fenceReason === "heartbeat-ambiguous") &&
		Number.isSafeInteger(record.fencedForMs) &&
		(record.fencedForMs as number) >= 0 &&
		Number.isSafeInteger(record.uptimeMs) &&
		(record.uptimeMs as number) >= 0 &&
		Number.isSafeInteger(record.pid) &&
		(record.pid as number) > 0 &&
		(record.signal === null || record.signal === "SIGINT" || record.signal === "SIGTERM") &&
		(record.reason === "signal") === (record.signal !== null) &&
		Number.isSafeInteger(record.writtenAt) &&
		(record.writtenAt as number) > 0
	);
}

/** Atomically persist the latest bounded graceful-exit reason for supervisors. */
export async function writeBrokerExitRecord(agentDir: string, record: BrokerExitRecord): Promise<void> {
	const serialized = JSON.stringify(record);
	if (Buffer.byteLength(serialized, "utf8") > MAX_BROKER_EXIT_RECORD_BYTES)
		throw new Error("SDK broker exit record exceeds its size bound.");

	const destination = brokerExitRecordPath(agentDir);
	const directory = path.dirname(destination);
	const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
	await fs.mkdir(directory, { recursive: true, mode: 0o700 });
	let published = false;
	try {
		const handle = await fs.open(temporary, "wx", 0o600);
		try {
			await handle.writeFile(serialized, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		await fs.rename(temporary, destination);
		published = true;
	} finally {
		if (!published) await fs.rm(temporary, { force: true }).catch(() => {});
	}
}

/** Read the bounded previous-exit record; malformed or absent files are ignored. */
export async function readBrokerExitRecord(agentDir: string): Promise<BrokerExitRecord | undefined> {
	try {
		const file = Bun.file(brokerExitRecordPath(agentDir));
		if (!(await file.exists()) || file.size > MAX_BROKER_EXIT_RECORD_BYTES) return undefined;
		const value: unknown = JSON.parse(await file.text());
		return isBrokerExitRecord(value) ? value : undefined;
	} catch {
		return undefined;
	}
}
