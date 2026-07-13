import * as fs from "node:fs/promises";
import path from "node:path";
import { assertSupportedStateVersion, SDK_STATE_VERSION } from "./state-version";
export type LifecycleState =
	| "accepted"
	| "effect_started"
	| "awaiting_ready"
	| "terminal_ok"
	| "terminal_error"
	| "terminal_uncertain";
export interface LifecycleWorktreeIntent {
	repoRoot: string;
	worktreePath: string;
	detached: boolean;
	baseRef: string;
	branchName?: string;
}

export interface LifecycleEffectIntent {
	sessionId: string;
	worktree?: LifecycleWorktreeIntent;
}

export interface LifecycleLedgerEntry {
	version: typeof SDK_STATE_VERSION;
	identity: string;
	requestHash: string;
	state: LifecycleState;
	intendedSessionId?: string;
	resultSessionId?: string;
	effectMarker?: string;
	effectIntent?: LifecycleEffectIntent;

	endpointGeneration?: number;
	responseDigest?: string;
	response?: unknown;
	ts: number;
}
export type BeginResult =
	| { kind: "new"; entry: LifecycleLedgerEntry }
	| { kind: "replay"; entry: LifecycleLedgerEntry }
	| { kind: "idempotency_conflict" }
	| { kind: "terminal_uncertain"; entry: LifecycleLedgerEntry }
	| { kind: "in_progress"; entry: LifecycleLedgerEntry };
const terminal = (s: LifecycleState) => s === "terminal_ok" || s === "terminal_error";
export class LifecycleLedger {
	#file: string;
	#corruptFile: string;
	#entries: LifecycleLedgerEntry[] = [];
	#byIdentity = new Map<string, LifecycleLedgerEntry>();
	#warnings: string[] = [];
	constructor(agentDir: string) {
		this.#file = path.join(agentDir, "sdk", "lifecycle-ledger.jsonl");
		this.#corruptFile = `${this.#file}.corrupt`;
	}
	async open(): Promise<this> {
		await this.assertSupportedStateVersions();
		await fs.mkdir(path.dirname(this.#file), { recursive: true, mode: 0o700 });
		this.#entries = [];
		this.#byIdentity.clear();
		this.#warnings = [];
		const uncertainAfterCorruption = new Set<string>();
		let tornTail = false;
		try {
			const source = await fs.readFile(this.#file, "utf8");
			tornTail = source.length > 0 && !source.endsWith("\n");
			const lines = source.split("\n");
			for (const line of lines) {
				if (!line) continue;
				try {
					const e = JSON.parse(line) as LifecycleLedgerEntry;
					assertSupportedStateVersion(this.#file, e);
					if (!e.identity || !e.requestHash || !e.state) throw new Error("invalid ledger entry");
					this.#entries.push(e);
					this.#byIdentity.set(e.identity, e);
					uncertainAfterCorruption.delete(e.identity);
				} catch {
					for (const [identity, latest] of this.#byIdentity) {
						if (!terminal(latest.state) && latest.state !== "terminal_uncertain")
							uncertainAfterCorruption.add(identity);
					}
					await this.#quarantine(line);
				}
			}
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
		}
		if (tornTail) await this.#sealTornTail();
		for (const identity of uncertainAfterCorruption) {
			const entry = this.#byIdentity.get(identity);
			if (entry && !terminal(entry.state) && entry.state !== "terminal_uncertain") {
				await this.#append({ ...entry, state: "terminal_uncertain", ts: Date.now() });
			}
		}
		// Effects may have completed after the last durable marker; do not retry them after a restart.
		for (const entry of [...this.#byIdentity.values()]) {
			if (entry.state === "effect_started" || entry.state === "awaiting_ready")
				await this.#append({ ...entry, state: "terminal_uncertain", ts: Date.now() });
		}
		return this;
	}
	async #sealTornTail(): Promise<void> {
		const h = await fs.open(this.#file, "a", 0o600);
		try {
			await h.writeFile("\n");
			await h.sync();
		} finally {
			await h.close();
		}
	}
	async #quarantine(line: string): Promise<void> {
		const h = await fs.open(this.#corruptFile, "a", 0o600);
		try {
			await h.writeFile(`${line}\n`);
			await h.sync();
		} finally {
			await h.close();
		}
		this.#warnings.push("Malformed lifecycle ledger entry quarantined");
	}
	get warnings(): readonly string[] {
		return this.#warnings;
	}
	async #append(entry: LifecycleLedgerEntry): Promise<LifecycleLedgerEntry> {
		const h = await fs.open(this.#file, "a", 0o600);
		try {
			await h.writeFile(`${JSON.stringify(entry)}\n`);
			await h.sync();
		} finally {
			await h.close();
		}
		this.#entries.push(entry);
		this.#byIdentity.set(entry.identity, entry);
		return entry;
	}
	async begin(identity: string, requestHash: string): Promise<BeginResult> {
		const prior = this.#byIdentity.get(identity);
		if (!prior)
			return {
				kind: "new",
				entry: await this.#append({
					version: SDK_STATE_VERSION,
					identity,
					requestHash,
					state: "accepted",
					ts: Date.now(),
				}),
			};
		if (prior.requestHash !== requestHash) return { kind: "idempotency_conflict" };
		if (terminal(prior.state)) return { kind: "replay", entry: prior };
		if (prior.state === "terminal_uncertain") return { kind: "terminal_uncertain", entry: prior };
		// An accepted row has no durable side effect. Target serialization makes retrying it safe.
		if (prior.state === "accepted") return { kind: "new", entry: prior };
		return { kind: "in_progress", entry: prior };
	}
	async transition(
		identity: string,
		state: LifecycleState,
		fields: Omit<Partial<LifecycleLedgerEntry>, "identity" | "requestHash" | "state" | "ts"> = {},
	): Promise<LifecycleLedgerEntry> {
		const previous = this.#byIdentity.get(identity);
		if (!previous) throw new Error("Unknown lifecycle identity");
		return this.#append({ ...previous, ...fields, state, ts: Date.now() });
	}
	async assertSupportedStateVersions(): Promise<void> {
		let source: string;
		try {
			source = await fs.readFile(this.#file, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		for (const line of source.split("\n")) {
			if (!line) continue;
			try {
				assertSupportedStateVersion(this.#file, JSON.parse(line));
			} catch (error) {
				if (error instanceof Error && "code" in error && error.code === "unsupported_state_version") throw error;
			}
		}
	}

	get(identity: string): LifecycleLedgerEntry | undefined {
		return this.#byIdentity.get(identity);
	}
}
