import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { withFileLock } from "../../config/file-lock";
import { assertSupportedStateVersion, SDK_STATE_VERSION, UnsupportedStateVersionError } from "./state-version";

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
async function appendSync(file: string, value: string): Promise<void> {
	const h = await fs.open(file, "a", 0o600);
	try {
		await h.write(`${value}\n`);
		await h.sync();
	} finally {
		await h.close();
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
	constructor(agentDir: string) {
		this.#agentDir = agentDir;
	}
	async open(): Promise<this> {
		await this.assertSupportedStateVersions();
		await fs.mkdir(dirFor(this.#agentDir), { recursive: true, mode: 0o700 });
		await fs.chmod(dirFor(this.#agentDir), 0o700);
		await this.replay();
		return this;
	}
	async replay(): Promise<void> {
		this.#events = [];
		this.#warnings = [];
		this.#logOffset = 0;
		let snapshotSeq = 0;
		try {
			const snapshot = JSON.parse(await fs.readFile(snapshotFor(this.#agentDir), "utf8")) as {
				version?: number;
				events?: SessionIndexEvent[];
				indexSeq?: number;
			};
			assertSupportedStateVersion(snapshotFor(this.#agentDir), snapshot);
			const snapshotIndexSeq = snapshot.indexSeq;
			if (
				typeof snapshotIndexSeq !== "number" ||
				!Number.isSafeInteger(snapshotIndexSeq) ||
				snapshotIndexSeq < 0 ||
				!Array.isArray(snapshot.events) ||
				snapshot.events.some(event => {
					const { checksum, ...unsigned } = event;
					return event.indexSeq > snapshotIndexSeq || checksum !== sessionIndexChecksum(unsigned);
				})
			)
				throw new Error("invalid snapshot");
			this.#events = snapshot.events;
			snapshotSeq = snapshotIndexSeq;
		} catch (e) {
			if (e instanceof UnsupportedStateVersionError) throw e;
			if ((e as NodeJS.ErrnoException).code !== "ENOENT") this.#warnings.push("Invalid session index snapshot");
		}
		await this.#tail(snapshotSeq);
	}
	async #tail(snapshotSeq = this.indexSeq): Promise<void> {
		let data: Buffer;
		try {
			const handle = await fs.open(logFor(this.#agentDir), "r");
			try {
				const stat = await handle.stat();
				if (stat.size < this.#logOffset) {
					this.#warnings.push("Session index log was truncated");
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
		if (lastNewline < 0) return;
		const consumed = data.subarray(0, lastNewline + 1);
		this.#logOffset += consumed.length;
		for (const line of consumed.toString("utf8").split("\n")) {
			if (!line) continue;
			let event: SessionIndexEvent;
			try {
				event = JSON.parse(line) as SessionIndexEvent;
				assertSupportedStateVersion(logFor(this.#agentDir), event);
			} catch (error) {
				if (error instanceof UnsupportedStateVersionError) throw error;
				this.#warnings.push("Corrupt session index entry; replay truncated");
				return;
			}
			if (event.indexSeq <= snapshotSeq) continue;
			const { checksum, ...unsigned } = event;
			if (checksum !== sessionIndexChecksum(unsigned) || event.indexSeq !== this.indexSeq + 1) {
				this.#warnings.push("Corrupt session index entry; replay truncated");
				return;
			}
			this.#events.push(event);
		}
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
			await this.refresh();
			const unsigned: Omit<SessionIndexEvent, "checksum"> = {
				...input,
				version: SDK_STATE_VERSION,
				indexSeq: this.indexSeq + 1,
				ts: input.ts ?? Date.now(),
			};
			const event: SessionIndexEvent = { ...unsigned, checksum: sessionIndexChecksum(unsigned) };
			await appendSync(logFor(this.#agentDir), JSON.stringify(event));
			await this.refresh();
			return event;
		});
	}
	async snapshot(): Promise<void> {
		const file = snapshotFor(this.#agentDir);
		const tmp = `${file}.${process.pid}.tmp`;
		await fs.writeFile(
			tmp,
			JSON.stringify({ version: SDK_STATE_VERSION, indexSeq: this.indexSeq, events: this.#events }),
			{ mode: 0o600 },
		);
		const h = await fs.open(tmp, "r");
		try {
			await h.sync();
		} finally {
			await h.close();
		}
		await fs.rename(tmp, file);
	}
	async assertSupportedStateVersions(): Promise<void> {
		const files = [snapshotFor(this.#agentDir), logFor(this.#agentDir)];
		for (const file of files) {
			let source: string;
			try {
				source = await fs.readFile(file, "utf8");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
				throw error;
			}
			if (file.endsWith(".json")) {
				assertSupportedStateVersion(file, JSON.parse(source));
				continue;
			}
			for (const line of source.split("\n")) {
				if (!line) continue;
				try {
					assertSupportedStateVersion(file, JSON.parse(line));
				} catch (error) {
					if (error instanceof UnsupportedStateVersionError) throw error;
				}
			}
		}
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

	hasHostUnregistered(sessionId: string, endpointGeneration: number, pid: number): boolean {
		return this.#events.some(
			event =>
				event.type === "host_unregistered" &&
				event.sessionId === sessionId &&
				event.endpointGeneration === endpointGeneration &&
				event.pid === pid,
		);
	}
}
