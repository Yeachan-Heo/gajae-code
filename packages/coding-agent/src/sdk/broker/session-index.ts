import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { withFileLock } from "../../config/file-lock";
import {
	assertSupportedSnapshotVersion,
	assertSupportedStateVersion,
	SDK_STATE_VERSION,
	SESSION_INDEX_SNAPSHOT_VERSION,
	UnsupportedStateVersionError,
} from "./state-version";

export type SessionIndexEventType =
	| "host_registered"
	| "host_heartbeat"
	| "host_unregistered"
	| "lifecycle_started"
	| "lifecycle_terminal"
	| "session_closed"
	| "record_reconciled";
export interface SessionIndexEvent {
	version: typeof SDK_STATE_VERSION;
	indexSeq: number;
	type: SessionIndexEventType;
	sessionId: string;
	locator: { repo: string; stateRoot: string };
	endpointGeneration: number;
	pid: number;
	endpointMtimeMs?: number;
	lifecycleRequestId?: string;
	terminalUncertain?: boolean;
	ts: number;
	checksum: string;
}
export interface IndexedSession {
	sessionId: string;
	locator: { repo: string; stateRoot: string };
	endpointGeneration: number;
	pid: number;
	endpointMtimeMs?: number;
	live: boolean;
	indexSeq: number;
	lifecycleRequestId?: string;
	terminalUncertain?: boolean;
}
export interface SessionList {
	indexSeq: number;
	sessions: IndexedSession[];
	warnings: string[];
}
const canonical = (event: Omit<SessionIndexEvent, "checksum">) => JSON.stringify(event);
export const sessionIndexChecksum = (event: Omit<SessionIndexEvent, "checksum">) =>
	createHash("sha256").update(canonical(event)).digest("hex");
const dirFor = (agentDir: string) => path.join(agentDir, "sdk", "sessions");
const logFor = (agentDir: string) => path.join(dirFor(agentDir), "index.jsonl");
const snapshotFor = (agentDir: string) => path.join(dirFor(agentDir), "index.snapshot.json");
const ROTATE_BYTES = 4 * 1024 * 1024;
function isValidSnapshot(snapshot: unknown): snapshot is { indexSeq: number; events: SessionIndexEvent[] } {
	if (!snapshot || typeof snapshot !== "object") return false;
	const { indexSeq, events } = snapshot as { indexSeq?: unknown; events?: unknown };
	if (typeof indexSeq !== "number" || !Number.isSafeInteger(indexSeq) || indexSeq < 0) return false;
	if (!Array.isArray(events)) return false;
	if (events.length === 0) return indexSeq === 0;
	// Accept strictly-increasing indexSeq (gaps allowed after compaction), preserving
	// each event's original checksum. The old contiguous 1..N format is a special case.
	let previous = 0;
	for (const event of events) {
		if (!event || typeof event !== "object") return false;
		const { checksum, ...unsigned } = event as SessionIndexEvent;
		if (typeof event.indexSeq !== "number" || !Number.isSafeInteger(event.indexSeq)) return false;
		if (event.indexSeq <= previous) return false;
		if (checksum !== sessionIndexChecksum(unsigned)) return false;
		previous = event.indexSeq;
	}
	return previous === indexSeq;
}

// Compact the event history for a snapshot without renumbering: clients hold indexSeq
// across calls, so retained events keep their original indexSeq and checksum. Drops
// terminal+dead sessions entirely, collapses superseded heartbeats to the latest per
// surviving session, and always retains the global-max indexSeq as the chain anchor.
function compactEvents(events: SessionIndexEvent[]): SessionIndexEvent[] {
	if (events.length === 0) return events;
	const maxIndexSeq = events[events.length - 1]!.indexSeq;
	const latestBySession = new Map<string, SessionIndexEvent>();
	for (const event of events) latestBySession.set(event.sessionId, event);
	const deadTerminal = new Set<string>();
	for (const [sessionId, latest] of latestBySession) {
		const terminal = latest.type === "host_unregistered" || latest.type === "session_closed";
		if (terminal && !alive(latest.pid)) deadTerminal.add(sessionId);
	}
	const latestHeartbeatSeq = new Map<string, number>();
	for (const event of events) {
		if (event.type === "host_heartbeat" && !deadTerminal.has(event.sessionId)) {
			latestHeartbeatSeq.set(event.sessionId, event.indexSeq);
		}
	}
	const kept: SessionIndexEvent[] = [];
	for (const event of events) {
		if (event.indexSeq === maxIndexSeq) {
			kept.push(event);
			continue;
		}
		if (deadTerminal.has(event.sessionId)) continue;
		if (event.type === "host_heartbeat" && latestHeartbeatSeq.get(event.sessionId) !== event.indexSeq) continue;
		kept.push(event);
	}
	return kept;
}

async function appendSync(file: string, value: string): Promise<void> {
	const h = await fs.open(file, "a", 0o600);
	try {
		const data = Buffer.from(`${value}\n`);
		for (let offset = 0; offset < data.length; ) {
			const { bytesWritten } = await h.write(data, offset, data.length - offset);
			if (bytesWritten <= 0) throw new Error("Unable to append session index entry");
			offset += bytesWritten;
		}
		await h.sync();
	} finally {
		await h.close();
	}
}

async function syncDirectory(file: string): Promise<void> {
	let handle: fs.FileHandle;
	try {
		handle = await fs.open(path.dirname(file), "r");
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

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}
export class SessionIndex {
	#agentDir: string;
	#events: SessionIndexEvent[] = [];
	#warnings: string[] = [];
	#logOffset = 0;
	#corruptSuffix = false;
	constructor(agentDir: string) {
		this.#agentDir = agentDir;
	}
	async open(): Promise<this> {
		await fs.mkdir(dirFor(this.#agentDir), { recursive: true, mode: 0o700 });
		await fs.chmod(dirFor(this.#agentDir), 0o700);
		await withFileLock(logFor(this.#agentDir), () => this.replay());
		return this;
	}
	async replay(): Promise<void> {
		this.#events = [];
		this.#warnings = [];
		this.#logOffset = 0;
		this.#corruptSuffix = false;
		let snapshotSeq = 0;
		try {
			const snapshot = JSON.parse(await fs.readFile(snapshotFor(this.#agentDir), "utf8")) as {
				version?: number;
				events?: SessionIndexEvent[];
				indexSeq?: number;
			};
			assertSupportedSnapshotVersion(snapshotFor(this.#agentDir), snapshot);
			if (!isValidSnapshot(snapshot)) throw new Error("invalid snapshot");
			this.#events = snapshot.events;
			snapshotSeq = snapshot.indexSeq;
		} catch (e) {
			if (e instanceof UnsupportedStateVersionError) throw e;
			if ((e as NodeJS.ErrnoException).code !== "ENOENT") this.#warnings.push("Invalid session index snapshot");
		}
		await this.#tail(snapshotSeq, false);
	}
	async #tail(snapshotSeq = this.indexSeq, allowResync = true): Promise<void> {
		let data: Buffer;
		try {
			const handle = await fs.open(logFor(this.#agentDir), "r");
			try {
				const stat = await handle.stat();
				if (stat.size < this.#logOffset) {
					if (allowResync) await this.replay();
					else this.#warn("Session index log was truncated");
					return;
				}
				data = Buffer.alloc(stat.size - this.#logOffset);
				if (data.length) await handle.read(data, 0, data.length, this.#logOffset);
			} finally {
				await handle.close();
			}
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
			throw e;
		}
		const lastNewline = data.lastIndexOf(0x0a);
		const consumed = data.subarray(0, lastNewline + 1);
		this.#logOffset += consumed.length;
		const hasUnterminatedSuffix = data.length > consumed.length;
		let corrupt = false;
		for (const line of consumed.toString("utf8").split("\n")) {
			if (!line) continue;
			let event: SessionIndexEvent;
			try {
				event = JSON.parse(line) as SessionIndexEvent;
				assertSupportedStateVersion(logFor(this.#agentDir), event);
			} catch (error) {
				if (error instanceof UnsupportedStateVersionError) throw error;
				corrupt = true;
				continue;
			}
			if (corrupt || event.indexSeq <= snapshotSeq) continue;
			const { checksum, ...unsigned } = event;
			if (checksum !== sessionIndexChecksum(unsigned) || event.indexSeq !== this.indexSeq + 1) corrupt = true;
			else this.#events.push(event);
		}
		if (hasUnterminatedSuffix) corrupt = true;
		if (corrupt) {
			this.#corruptSuffix = true;
			this.#warn("Corrupt session index entry; replay truncated");
			if (allowResync) await this.replay();
		}
	}
	#warn(message: string): void {
		if (!this.#warnings.includes(message)) this.#warnings.push(message);
	}

	async refresh(): Promise<void> {
		await this.#tail();
	}
	get indexSeq(): number {
		return this.#events.at(-1)?.indexSeq ?? 0;
	}
	async append(
		input: Omit<SessionIndexEvent, "version" | "indexSeq" | "checksum" | "ts"> &
			Partial<Pick<SessionIndexEvent, "ts">>,
	): Promise<SessionIndexEvent> {
		await fs.mkdir(dirFor(this.#agentDir), { recursive: true, mode: 0o700 });
		return withFileLock(logFor(this.#agentDir), async () => {
			await this.replay();
			if (this.#corruptSuffix) throw new Error("Cannot append to corrupt session index log");
			const unsigned: Omit<SessionIndexEvent, "checksum"> = {
				...input,
				version: SDK_STATE_VERSION,
				indexSeq: this.indexSeq + 1,
				ts: input.ts ?? Date.now(),
			};
			const event: SessionIndexEvent = { ...unsigned, checksum: sessionIndexChecksum(unsigned) };
			await appendSync(logFor(this.#agentDir), JSON.stringify(event));
			await this.refresh();
			if ((await fs.stat(logFor(this.#agentDir))).size >= ROTATE_BYTES) await this.#rotate();
			return event;
		});
	}
	async snapshot(): Promise<void> {
		await withFileLock(logFor(this.#agentDir), () => this.#snapshotUnderLock());
	}
	async #snapshotUnderLock(): Promise<void> {
		await this.replay();
		const file = snapshotFor(this.#agentDir);
		let current: unknown;
		try {
			current = JSON.parse(await fs.readFile(file, "utf8"));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
		}
		if (isValidSnapshot(current) && current.indexSeq > this.indexSeq) return;
		const tmp = `${file}.${process.pid}.tmp`;
		await fs.writeFile(
			tmp,
			JSON.stringify({
				version: SESSION_INDEX_SNAPSHOT_VERSION,
				indexSeq: this.indexSeq,
				events: compactEvents(this.#events),
			}),
			{
				mode: 0o600,
			},
		);
		const h = await fs.open(tmp, "r");
		try {
			await h.sync();
		} finally {
			await h.close();
		}
		await fs.rename(tmp, file);
		await syncDirectory(file);
	}
	async #rotate(): Promise<void> {
		await this.#snapshotUnderLock();
		const file = logFor(this.#agentDir);
		const temporary = `${file}.${process.pid}.tmp`;
		await fs.writeFile(temporary, "", { mode: 0o600 });
		await fs.rename(temporary, file);
		await syncDirectory(file);
		this.#logOffset = 0;
	}

	listSessions(): SessionList {
		const latest = new Map<string, SessionIndexEvent>();
		for (const event of this.#events) {
			const previous = latest.get(event.sessionId);
			latest.set(
				event.sessionId,
				event.type === "host_heartbeat" && previous
					? {
							...event,
							locator: previous.locator,
							endpointMtimeMs: previous.endpointMtimeMs,
							lifecycleRequestId: previous.lifecycleRequestId,
						}
					: event,
			);
		}
		const sessions = [...latest.values()]
			.filter(event => !["host_unregistered", "session_closed"].includes(event.type))
			.map(event => ({
				sessionId: event.sessionId,
				locator: event.locator,
				endpointGeneration: event.endpointGeneration,
				pid: event.pid,
				endpointMtimeMs: event.endpointMtimeMs,
				lifecycleRequestId: event.lifecycleRequestId,
				terminalUncertain: event.type === "lifecycle_terminal" || event.terminalUncertain === true,
				indexSeq: event.indexSeq,
				live: alive(event.pid),
			}));
		return { indexSeq: this.indexSeq, sessions, warnings: this.#warnings };
	}

	hostUnregisteredAfter(
		registration: Pick<
			IndexedSession,
			"sessionId" | "endpointGeneration" | "pid" | "indexSeq" | "lifecycleRequestId"
		>,
	): { indexSeq: number; lifecycleRequestId?: string } | undefined {
		const lifecycleRequestId = registration.lifecycleRequestId;
		const event = this.#events.findLast(
			item =>
				item.type === "host_unregistered" &&
				item.indexSeq > registration.indexSeq &&
				item.sessionId === registration.sessionId &&
				item.endpointGeneration === registration.endpointGeneration &&
				item.pid === registration.pid &&
				(lifecycleRequestId === undefined || item.lifecycleRequestId === lifecycleRequestId),
		);
		return event
			? {
					indexSeq: event.indexSeq,
					...(lifecycleRequestId ? { lifecycleRequestId } : {}),
				}
			: undefined;
	}

	findHostRegistration(
		sessionId: string,
		endpointGeneration: number,
		pid: number,
		lifecycleRequestId?: string,
	): IndexedSession | undefined {
		const event = this.#events.findLast(
			item =>
				item.type === "host_registered" &&
				item.sessionId === sessionId &&
				item.endpointGeneration === endpointGeneration &&
				item.pid === pid &&
				(lifecycleRequestId === undefined || item.lifecycleRequestId === lifecycleRequestId),
		);
		return event
			? {
					sessionId: event.sessionId,
					locator: event.locator,
					endpointGeneration: event.endpointGeneration,
					pid: event.pid,
					endpointMtimeMs: event.endpointMtimeMs,
					lifecycleRequestId: event.lifecycleRequestId,
					terminalUncertain: false,
					indexSeq: event.indexSeq,
					live: alive(event.pid),
				}
			: undefined;
	}

	hasHostRegistrationForLifecycle(sessionId: string, pid: number, lifecycleRequestId: string): boolean {
		return this.#events.some(
			event =>
				event.type === "host_registered" &&
				event.sessionId === sessionId &&
				event.pid === pid &&
				event.lifecycleRequestId === lifecycleRequestId,
		);
	}
}
