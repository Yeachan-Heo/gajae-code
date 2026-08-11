import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { BrokerResponse } from "./broker";

interface PendingReceipt {
	version: 1;
	clientRef: string;
	digest: string;
	state: "pending";
	ts: number;
}

interface CompletedReceipt {
	version: 1;
	clientRef: string;
	digest: string;
	state: "completed";
	response: BrokerResponse;
	ts: number;
}

type OperationReceipt = PendingReceipt | CompletedReceipt;

function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
		.join(",")}}`;
}

export type OperationReserveResult =
	| { status: "reserved" }
	| { status: "replay"; response: BrokerResponse }
	| { status: "in_progress" }
	| { status: "conflict" };

function isReceipt(value: unknown): value is OperationReceipt {
	if (!value || typeof value !== "object") return false;
	const row = value as Partial<OperationReceipt>;
	return (
		row.version === 1 &&
		typeof row.clientRef === "string" &&
		row.clientRef.length > 0 &&
		typeof row.digest === "string" &&
		/^[0-9a-f]{64}$/.test(row.digest) &&
		(row.state === "pending" || (row.state === "completed" && typeof row.response === "object")) &&
		typeof row.ts === "number"
	);
}

/**
 * Target-session-scoped idempotency key for a clientRef. Identical refs on
 * different sessions are independent, so a receipt can never replay or
 * conflict across sessions.
 */
export function operationReceiptKey(sessionId: string, clientRef: string): string {
	return `${sessionId}\u0000${clientRef}`;
}

export function operationReceiptDigest(operation: string, input: Record<string, unknown>, sessionId?: string): string {
	return createHash("sha256")
		.update(canonicalJson({ operation, input, ...(sessionId === undefined ? {} : { sessionId }) }))
		.digest("hex");
}

export class OperationReceiptLedger {
	readonly #file: string;
	readonly #latest = new Map<string, OperationReceipt>();
	#chain: Promise<void> = Promise.resolve();

	constructor(agentDir: string) {
		this.#file = path.join(agentDir, "sdk", "operation-receipts.jsonl");
	}

	async open(): Promise<void> {
		await fs.mkdir(path.dirname(this.#file), { recursive: true, mode: 0o700 });
		let source = "";
		try {
			source = await fs.readFile(this.#file, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		for (const line of source.split("\n")) {
			if (!line) continue;
			try {
				const row: unknown = JSON.parse(line);
				if (isReceipt(row)) this.#latest.set(row.clientRef, row);
			} catch {
				// A torn final append is fail-closed: any earlier pending row remains authoritative.
			}
		}
	}

	async reserve(clientRef: string, digest: string): Promise<OperationReserveResult> {
		return this.#serial(async () => {
			const current = this.#latest.get(clientRef);
			if (current) {
				if (current.digest !== digest) return { status: "conflict" };
				if (current.state === "completed") return { status: "replay", response: current.response };
				return { status: "in_progress" };
			}
			const pending: PendingReceipt = { version: 1, clientRef, digest, state: "pending", ts: Date.now() };
			await this.#append(pending);
			this.#latest.set(clientRef, pending);
			return { status: "reserved" };
		});
	}

	async complete(clientRef: string, digest: string, response: BrokerResponse): Promise<void> {
		await this.#serial(async () => {
			const current = this.#latest.get(clientRef);
			if (!current || current.digest !== digest)
				throw new Error("Operation receipt reservation is missing or mismatched");
			if (current.state === "completed") return;
			const completed: CompletedReceipt = {
				version: 1,
				clientRef,
				digest,
				state: "completed",
				response,
				ts: Date.now(),
			};
			await this.#append(completed);
			this.#latest.set(clientRef, completed);
		});
	}

	async #append(row: OperationReceipt): Promise<void> {
		const handle = await fs.open(this.#file, "a", 0o600);
		try {
			await handle.writeFile(`${JSON.stringify(row)}\n`);
			await handle.sync();
		} finally {
			await handle.close();
		}
	}

	async #serial<T>(operation: () => Promise<T>): Promise<T> {
		const previous = this.#chain;
		const next = Promise.withResolvers<void>();
		this.#chain = next.promise;
		await previous;
		try {
			return await operation();
		} finally {
			next.resolve();
		}
	}
}
