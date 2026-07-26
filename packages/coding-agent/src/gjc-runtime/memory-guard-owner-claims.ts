import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import { type LinuxProcPidProbeResult, probeLinuxProcPid } from "./linux-proc";
import { assertSafePathComponent } from "./session-layout";
import { memoryGuardClaimPaths } from "./tmux-owner-isolation";

const MEMORY_GUARD_CLAIM_RESOURCES = ["writer", "tty"] as const;
type MemoryGuardClaimResource = (typeof MEMORY_GUARD_CLAIM_RESOURCES)[number];

export interface MemoryGuardClaimOwner {
	sessionId: string;
	generation: string;
	runId: string;
	childToken: string;
	pid: number;
	processStartTime: string;
	ttyDevice: string;
}

export interface MemoryGuardClaimsLease {
	writerEpoch: number;
	ttyEpoch: number;
	owner: MemoryGuardClaimOwner;
}

export type MemoryGuardClaimsReleasedProof = MemoryGuardClaimsLease;

interface PersistedMemoryGuardClaimRow {
	resource: MemoryGuardClaimResource;
	epoch: number;
	session_id: string;
	generation: string;
	run_id: string;
	child_token: string;
	pid: number;
	process_start_time: string;
	tty_device: string;
	acquired_at: string;
}

export interface MemoryGuardOwnerClaimsDeps {
	probePid(pid: number): Promise<LinuxProcPidProbeResult>;
	now(): string;
}

const defaultDeps: MemoryGuardOwnerClaimsDeps = {
	probePid,
	now: () => new Date().toISOString(),
};

function probePid(pid: number): Promise<LinuxProcPidProbeResult> {
	return probeLinuxProcPid(pid);
}

function assertClaimOwner(owner: MemoryGuardClaimOwner): void {
	for (const [value, label] of [
		[owner.sessionId, "memory guard session id"],
		[owner.generation, "memory guard generation"],
		[owner.runId, "memory guard run id"],
		[owner.childToken, "memory guard child token"],
	] as const) {
		assertSafePathComponent(value, label);
	}
	if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new Error("memory_guard_claim_invalid_pid");
	if (!/^\d+$/.test(owner.processStartTime)) throw new Error("memory_guard_claim_invalid_process_start_time");
	if (!/^-?\d+$/.test(owner.ttyDevice)) throw new Error("memory_guard_claim_invalid_tty_device");
}

async function prepareClaimDirectory(root: string): Promise<void> {
	await fs.mkdir(root, { recursive: true, mode: 0o700 });
	await fs.chmod(root, 0o700);
}

async function enforceDatabaseModes(databaseFile: string): Promise<void> {
	for (const file of [databaseFile, `${databaseFile}-wal`, `${databaseFile}-shm`]) {
		await fs.chmod(file, 0o600).catch(() => undefined);
	}
}

function configureClaimsDatabase(database: Database): void {
	database.exec("PRAGMA journal_mode = WAL");
	database.exec("PRAGMA synchronous = FULL");
	database.exec("PRAGMA busy_timeout = 1");
	database.exec(`
		CREATE TABLE IF NOT EXISTS meta(
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL
		);
		INSERT OR IGNORE INTO meta(key, value) VALUES ('epoch', '0');
		CREATE TABLE IF NOT EXISTS claims(
			resource TEXT PRIMARY KEY CHECK(resource IN ('writer', 'tty')),
			epoch INTEGER NOT NULL,
			session_id TEXT NOT NULL,
			generation TEXT NOT NULL,
			run_id TEXT NOT NULL,
			child_token TEXT NOT NULL,
			pid INTEGER NOT NULL,
			process_start_time TEXT NOT NULL,
			tty_device TEXT NOT NULL,
			acquired_at TEXT NOT NULL
		);
	`);
}

async function openClaimsDatabase(
	stateDir: string,
	sessionId: string,
): Promise<{ database: Database; databaseFile: string }> {
	assertSafePathComponent(sessionId, "memory guard session id");
	const paths = memoryGuardClaimPaths(stateDir, sessionId);
	await prepareClaimDirectory(paths.root);
	const database = new Database(paths.databaseFile, { create: true });
	configureClaimsDatabase(database);
	await enforceDatabaseModes(paths.databaseFile);
	return { database, databaseFile: paths.databaseFile };
}

function readEpoch(database: Database): number {
	const row = database.prepare("SELECT value FROM meta WHERE key = 'epoch'").get() as { value: string } | null;
	if (!row || !/^\d+$/.test(row.value)) throw new Error("memory_guard_claim_epoch_invalid");
	const value = Number(row.value);
	if (!Number.isSafeInteger(value) || value < 0) throw new Error("memory_guard_claim_epoch_invalid");
	return value;
}

function allocateEpoch(database: Database): number {
	const next = readEpoch(database) + 1;
	if (!Number.isSafeInteger(next) || next <= 0) throw new Error("memory_guard_claim_epoch_overflow");
	database.prepare("UPDATE meta SET value = ? WHERE key = 'epoch'").run(String(next));
	return next;
}

function readClaimRows(database: Database): PersistedMemoryGuardClaimRow[] {
	const rows = database
		.prepare(
			"SELECT resource, epoch, session_id, generation, run_id, child_token, pid, process_start_time, tty_device, acquired_at FROM claims ORDER BY resource ASC",
		)
		.all() as PersistedMemoryGuardClaimRow[];
	for (const row of rows) {
		if (!MEMORY_GUARD_CLAIM_RESOURCES.includes(row.resource)) throw new Error("memory_guard_claim_resource_invalid");
		if (!Number.isSafeInteger(row.epoch) || row.epoch <= 0) throw new Error("memory_guard_claim_epoch_invalid");
	}
	return rows;
}

async function assertLiveOwner(owner: MemoryGuardClaimOwner, deps: MemoryGuardOwnerClaimsDeps): Promise<void> {
	const probe = await deps.probePid(owner.pid);
	if (probe.kind !== "live")
		throw new Error(
			`memory_guard_claim_owner_unverifiable:${probe.kind === "unverifiable" ? probe.reason : "absent"}`,
		);
	if (probe.startTime !== owner.processStartTime) throw new Error("memory_guard_claim_owner_start_time_mismatch");
	if (probe.ttyDevice !== owner.ttyDevice) throw new Error("memory_guard_claim_owner_tty_mismatch");
}

async function classifyExistingRow(
	row: PersistedMemoryGuardClaimRow,
	deps: MemoryGuardOwnerClaimsDeps,
): Promise<"live" | "reclaim"> {
	const probe = await deps.probePid(row.pid);
	if (probe.kind === "absent") return "reclaim";
	if (probe.kind === "live") return probe.startTime === row.process_start_time ? "live" : "reclaim";
	throw new Error(`memory_guard_claim_existing_owner_unverifiable:${probe.reason}`);
}

function insertClaimRow(
	database: Database,
	resource: MemoryGuardClaimResource,
	epoch: number,
	owner: MemoryGuardClaimOwner,
	acquiredAt: string,
): void {
	database
		.prepare(
			"INSERT INTO claims(resource, epoch, session_id, generation, run_id, child_token, pid, process_start_time, tty_device, acquired_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		)
		.run(
			resource,
			epoch,
			owner.sessionId,
			owner.generation,
			owner.runId,
			owner.childToken,
			owner.pid,
			owner.processStartTime,
			owner.ttyDevice,
			acquiredAt,
		);
}

function deleteExactClaimRow(
	database: Database,
	resource: MemoryGuardClaimResource,
	epoch: number,
	owner: MemoryGuardClaimOwner,
): number {
	return database
		.prepare(
			"DELETE FROM claims WHERE resource = ? AND epoch = ? AND session_id = ? AND generation = ? AND run_id = ? AND child_token = ? AND pid = ? AND process_start_time = ? AND tty_device = ?",
		)
		.run(
			resource,
			epoch,
			owner.sessionId,
			owner.generation,
			owner.runId,
			owner.childToken,
			owner.pid,
			owner.processStartTime,
			owner.ttyDevice,
		).changes;
}

function rollbackQuietly(database: Database): void {
	try {
		database.exec("ROLLBACK");
	} catch {
		return;
	}
}

export function memoryGuardClaimsDatabaseFile(stateDir: string, sessionId: string): string {
	return memoryGuardClaimPaths(stateDir, sessionId).databaseFile;
}

export async function acquireMemoryGuardClaims(
	stateDir: string,
	owner: MemoryGuardClaimOwner,
	deps: MemoryGuardOwnerClaimsDeps = defaultDeps,
): Promise<MemoryGuardClaimsLease> {
	assertClaimOwner(owner);
	await assertLiveOwner(owner, deps);
	const { database, databaseFile } = await openClaimsDatabase(stateDir, owner.sessionId);
	try {
		database.exec("BEGIN IMMEDIATE");
		for (const row of readClaimRows(database)) {
			const state = await classifyExistingRow(row, deps);
			if (state === "live") throw new Error(`memory_guard_claim_live_contention:${row.resource}`);
		}
		database.exec("DELETE FROM claims");
		const acquiredAt = deps.now();
		const writerEpoch = allocateEpoch(database);
		insertClaimRow(database, "writer", writerEpoch, owner, acquiredAt);
		const ttyEpoch = allocateEpoch(database);
		insertClaimRow(database, "tty", ttyEpoch, owner, acquiredAt);
		database.exec("COMMIT");
		await enforceDatabaseModes(databaseFile);
		return { writerEpoch, ttyEpoch, owner };
	} catch (error) {
		rollbackQuietly(database);
		throw error;
	} finally {
		database.close();
	}
}

export async function releaseMemoryGuardClaims(stateDir: string, claim: MemoryGuardClaimsLease): Promise<void> {
	assertClaimOwner(claim.owner);
	const { database } = await openClaimsDatabase(stateDir, claim.owner.sessionId);
	try {
		database.exec("BEGIN IMMEDIATE");
		const writerChanges = deleteExactClaimRow(database, "writer", claim.writerEpoch, claim.owner);
		const ttyChanges = deleteExactClaimRow(database, "tty", claim.ttyEpoch, claim.owner);
		if (writerChanges !== 1 || ttyChanges !== 1) throw new Error("memory_guard_claim_release_mismatch");
		database.exec("COMMIT");
	} catch (error) {
		rollbackQuietly(database);
		throw error;
	} finally {
		database.close();
	}
}

export async function probeMemoryGuardClaimsReleased(
	stateDir: string,
	owner: MemoryGuardClaimOwner,
	deps: MemoryGuardOwnerClaimsDeps = defaultDeps,
): Promise<MemoryGuardClaimsReleasedProof> {
	assertClaimOwner(owner);
	await assertLiveOwner(owner, deps);
	const { database, databaseFile } = await openClaimsDatabase(stateDir, owner.sessionId);
	try {
		database.exec("BEGIN IMMEDIATE");
		for (const row of readClaimRows(database)) {
			const state = await classifyExistingRow(row, deps);
			if (state === "live") throw new Error(`memory_guard_claims_still_live:${row.resource}`);
		}
		database.exec("DELETE FROM claims");
		const acquiredAt = deps.now();
		const writerEpoch = allocateEpoch(database);
		insertClaimRow(database, "writer", writerEpoch, owner, acquiredAt);
		const ttyEpoch = allocateEpoch(database);
		insertClaimRow(database, "tty", ttyEpoch, owner, acquiredAt);
		database.exec("COMMIT");
		await enforceDatabaseModes(databaseFile);
		const proof = { writerEpoch, ttyEpoch, owner };
		await releaseMemoryGuardClaims(stateDir, proof);
		return proof;
	} catch (error) {
		rollbackQuietly(database);
		throw error;
	} finally {
		database.close();
	}
}

export interface PersistedMemoryGuardClaimsSnapshot {
	epoch: number;
	claims: PersistedMemoryGuardClaimRow[];
}

export async function readMemoryGuardClaimsForTest(
	stateDir: string,
	sessionId: string,
): Promise<PersistedMemoryGuardClaimsSnapshot> {
	const { database } = await openClaimsDatabase(stateDir, sessionId);
	try {
		return {
			epoch: readEpoch(database),
			claims: readClaimRows(database),
		};
	} finally {
		database.close();
	}
}
