import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { processIncarnation } from "./process-incarnation";
import { assertSupportedStateVersion, SDK_STATE_VERSION } from "./state-version";

export const BROKER_HEARTBEAT_TTL_MS = 15_000;
export interface BrokerDiscovery {
	version: typeof SDK_STATE_VERSION;
	protocolVersion: 3;
	packageGeneration: string;
	ownerId: string;
	pid: number;
	incarnation: string;
	host: "127.0.0.1";
	port: number;
	url: string;
	token: string;
	startedAt: number;
	heartbeatAt: number;
}
export type RedactedBrokerDiscovery = Omit<BrokerDiscovery, "token"> & { token: "[redacted]" };
export type BrokerDiscoveryWrite = Omit<BrokerDiscovery, "incarnation"> & { incarnation?: string };
export const brokerDiscoveryPath = (agentDir: string) => path.join(agentDir, "sdk", "broker.json");
export const newBrokerToken = () => randomBytes(32).toString("hex");
export const brokerProcessIncarnation = processIncarnation;
export function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}
async function syncFile(file: string): Promise<void> {
	const handle = await fs.open(file, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function syncDirectory(directory: string): Promise<void> {
	let handle: fs.FileHandle;
	try {
		handle = await fs.open(directory, "r");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (process.platform === "win32" && (code === "EPERM" || code === "EACCES")) return;
		throw error;
	}
	try {
		await handle.sync();
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (process.platform !== "win32" || (code !== "EPERM" && code !== "EACCES")) throw error;
	} finally {
		await handle.close();
	}
}
export async function writeBrokerDiscovery(agentDir: string, discovery: BrokerDiscoveryWrite): Promise<void> {
	const incarnation = discovery.incarnation ?? brokerProcessIncarnation(discovery.pid);
	if (!incarnation) throw new Error(`Broker process incarnation is unavailable for pid ${discovery.pid}.`);
	const record: BrokerDiscovery = { ...discovery, incarnation };
	const file = brokerDiscoveryPath(agentDir);
	const dir = path.dirname(file);
	await fs.mkdir(dir, { recursive: true, mode: 0o700 });
	await fs.chmod(dir, 0o700);
	const temp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
	try {
		await fs.writeFile(temp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
		await fs.chmod(temp, 0o600);
		await syncFile(temp);
		await fs.rename(temp, file);
		await syncDirectory(dir);
	} finally {
		await fs.rm(temp, { force: true });
	}
}
export async function readBrokerDiscovery(
	agentDir: string,
	ttlMs = BROKER_HEARTBEAT_TTL_MS,
): Promise<BrokerDiscovery | null> {
	try {
		const raw: unknown = JSON.parse(await fs.readFile(brokerDiscoveryPath(agentDir), "utf8"));
		if (!raw || typeof raw !== "object") return null;
		assertSupportedStateVersion(brokerDiscoveryPath(agentDir), raw);
		const d = raw as BrokerDiscovery;
		if (
			d.version !== SDK_STATE_VERSION ||
			d.protocolVersion !== 3 ||
			d.host !== "127.0.0.1" ||
			!d.token ||
			!Number.isSafeInteger(d.pid) ||
			d.pid <= 0 ||
			typeof d.incarnation !== "string" ||
			d.incarnation.length === 0 ||
			!Number.isFinite(d.heartbeatAt)
		)
			return null;
		if (!isPidAlive(d.pid)) return null;
		const incarnation = brokerProcessIncarnation(d.pid);
		if (!incarnation || incarnation !== d.incarnation || Date.now() - d.heartbeatAt > ttlMs) return null;
		return d;
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT" || e instanceof SyntaxError) return null;
		throw e;
	}
}
export function redactBrokerDiscovery(discovery: BrokerDiscovery): RedactedBrokerDiscovery {
	return { ...discovery, token: "[redacted]" };
}
