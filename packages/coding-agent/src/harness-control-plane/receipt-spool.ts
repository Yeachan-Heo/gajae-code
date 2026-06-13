import { AsyncLocalStorage } from "node:async_hooks";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { withFileLock } from "../config/file-lock";
import type { ReceiptEnvelope } from "./receipts";

export const RECEIPT_SPOOL_DIR_ENV = "GJC_RECEIPT_SPOOL_DIR";
export const RECEIPT_SPOOL_FILENAME = "spool.jsonl";
export const RECEIPT_SPOOL_CURSOR_WIDTH = 12;

export interface ReceiptSpoolRecord {
	cursor: string;
	envelope: ReceiptEnvelope<unknown>;
}

export interface ReceiptSpoolAppendResult {
	cursor: string;
	path: string;
}

const receiptSpoolDirStorage = new AsyncLocalStorage<string | undefined>();
const spoolQueues = new Map<string, Promise<void>>();
const noop = (): void => undefined;
export async function withReceiptSpoolDir<T>(spoolDir: string, fn: () => Promise<T>): Promise<T> {
	const trimmed = spoolDir.trim();
	if (!trimmed) throw new Error("receipt_spool_dir_empty");
	const resolved = path.resolve(trimmed);
	return receiptSpoolDirStorage.run(resolved, fn);
}

export function resolveReceiptSpoolDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const active = receiptSpoolDirStorage.getStore();
	if (active !== undefined) return active;
	const raw = env[RECEIPT_SPOOL_DIR_ENV]?.trim();
	return raw ? path.resolve(raw) : undefined;
}

export function receiptSpoolPath(spoolDir: string): string {
	return path.join(path.resolve(spoolDir), RECEIPT_SPOOL_FILENAME);
}

function parseCursor(value: unknown): bigint | undefined {
	if (typeof value !== "string" || !/^\d+$/.test(value)) return undefined;
	try {
		return BigInt(value);
	} catch {
		return undefined;
	}
}

export function formatReceiptSpoolCursor(cursor: bigint): string {
	const raw = cursor.toString();
	return raw.length >= RECEIPT_SPOOL_CURSOR_WIDTH ? raw : raw.padStart(RECEIPT_SPOOL_CURSOR_WIDTH, "0");
}

export async function readHighestReceiptSpoolCursor(spoolDir: string): Promise<bigint> {
	const spoolFile = receiptSpoolPath(spoolDir);
	let raw: string;
	try {
		raw = await fs.readFile(spoolFile, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0n;
		throw error;
	}

	let highest = 0n;
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const parsed = JSON.parse(trimmed) as { cursor?: unknown };
			const cursor = parseCursor(parsed.cursor);
			if (cursor !== undefined && cursor > highest) highest = cursor;
		} catch {
			// A crash may leave a torn tail; consumers skip malformed lines and so do we.
		}
	}
	return highest;
}

async function enqueueSpoolAppend<T>(spoolFile: string, task: () => Promise<T>): Promise<T> {
	const previous = spoolQueues.get(spoolFile) ?? Promise.resolve();
	const running = previous.catch(noop).then(task);
	const normalized = running.then(noop, noop);
	spoolQueues.set(spoolFile, normalized);
	normalized
		.finally(() => {
			if (spoolQueues.get(spoolFile) === normalized) spoolQueues.delete(spoolFile);
		})
		.catch(noop);
	return running;
}

export async function appendReceiptToSpool(
	spoolDir: string,
	envelope: ReceiptEnvelope<unknown>,
): Promise<ReceiptSpoolAppendResult> {
	const resolvedDir = path.resolve(spoolDir);
	const spoolFile = receiptSpoolPath(resolvedDir);
	return enqueueSpoolAppend(spoolFile, async () => {
		await fs.mkdir(resolvedDir, { recursive: true, mode: 0o700 });
		return withFileLock(
			spoolFile,
			async () => {
				const cursor = formatReceiptSpoolCursor((await readHighestReceiptSpoolCursor(resolvedDir)) + 1n);
				const record: ReceiptSpoolRecord = { cursor, envelope };
				const handle = await fs.open(spoolFile, "a", 0o600);
				try {
					await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
					await handle.sync();
				} finally {
					await handle.close();
				}
				return { cursor, path: spoolFile };
			},
			{ staleMs: 30_000, retries: 100, retryDelayMs: 25 },
		);
	});
}

export async function appendReceiptToConfiguredSpool(
	envelope: ReceiptEnvelope<unknown>,
	env: NodeJS.ProcessEnv = process.env,
): Promise<ReceiptSpoolAppendResult | undefined> {
	const spoolDir = resolveReceiptSpoolDir(env);
	if (!spoolDir) return undefined;
	return appendReceiptToSpool(spoolDir, envelope);
}
