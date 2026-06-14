/**
 * Cross-process registry of running gjc RPC sessions (issue 10).
 *
 * Each live RPC server writes a record under `<agent-dir>/rpc-sessions/<id>.json`
 * on start and removes it on shutdown, so a separate process can discover which
 * sessions are alive (and, once persistence lands in issue 09, how to reach
 * them). Listing reaps records whose owning process is no longer alive, so a
 * crashed server never leaves a permanent phantom entry.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir } from "@gajae-code/utils";

export type RpcSessionTransport = "stdio" | "bridge" | "socket";

export interface RpcSessionRecord {
	sessionId: string;
	pid: number;
	transport: RpcSessionTransport;
	cwd: string;
	model?: string;
	/** ISO-8601 start timestamp. */
	startedAt: string;
	/** Reachable endpoint for persistent transports (issue 09); absent for stdio. */
	endpoint?: string;
}

/** Registry directory: `<agent-dir>/rpc-sessions` (honors GJC_CODING_AGENT_DIR via getAgentDir). */
function rpcSessionsDir(agentDir?: string): string {
	return path.join(agentDir ?? getAgentDir(), "rpc-sessions");
}

function recordPath(sessionId: string, agentDir?: string): string {
	return path.join(rpcSessionsDir(agentDir), `${sessionId}.json`);
}

/**
 * Write (or replace) the registry record for a session. The record is written to
 * a same-directory temp file and atomically renamed into place so a concurrent
 * reader never observes (and reaps) a partially-written record.
 */
export async function registerRpcSession(record: RpcSessionRecord, agentDir?: string): Promise<string> {
	const file = recordPath(record.sessionId, agentDir);
	// `.tmp` suffix keeps the staging file out of the `*.json` listing/reaping path.
	const staging = `${file}.${process.pid}.tmp`;
	await Bun.write(staging, JSON.stringify(record));
	await fs.rename(staging, file);
	return file;
}

/** Remove a session's registry record. Best-effort: a missing file is not an error. */
export async function unregisterRpcSession(sessionId: string, agentDir?: string): Promise<void> {
	await fs.rm(recordPath(sessionId, agentDir), { force: true });
}

function isProcessAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		// Signal 0 performs error checking without delivering a signal.
		process.kill(pid, 0);
		return true;
	} catch (err) {
		// ESRCH => no such process (dead). EPERM => alive but owned by another user.
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

function parseRecord(raw: string): RpcSessionRecord | undefined {
	let obj: Partial<RpcSessionRecord>;
	try {
		obj = JSON.parse(raw) as Partial<RpcSessionRecord>;
	} catch {
		return undefined;
	}
	if (typeof obj.sessionId !== "string" || typeof obj.pid !== "number") return undefined;
	return obj as RpcSessionRecord;
}

/**
 * List live RPC sessions, reaping records whose process is gone or whose file is
 * unparseable. Returns records sorted by `startedAt` ascending.
 */
export async function listRpcSessions(agentDir?: string): Promise<RpcSessionRecord[]> {
	const dir = rpcSessionsDir(agentDir);
	let entries: string[];
	try {
		entries = await fs.readdir(dir);
	} catch {
		return [];
	}
	const live: RpcSessionRecord[] = [];
	for (const entry of entries) {
		if (!entry.endsWith(".json")) continue;
		const file = path.join(dir, entry);
		let raw: string;
		try {
			raw = await fs.readFile(file, "utf8");
		} catch {
			continue;
		}
		const record = parseRecord(raw);
		if (!record || !isProcessAlive(record.pid)) {
			await fs.rm(file, { force: true });
			continue;
		}
		live.push(record);
	}
	return live.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}
