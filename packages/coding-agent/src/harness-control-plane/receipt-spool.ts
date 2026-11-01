import { AsyncLocalStorage } from "node:async_hooks";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { canonicalEnvKey, loadedProjectEnvSnapshot } from "@gajae-code/utils/dirs";
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
const NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;

/** True only when an exception's `code` is `ENOENT`. Other codes propagate. */
export function isEnoent(error: unknown): boolean {
	return (error as NodeJS.ErrnoException).code === "ENOENT";
}

/**
 * Bun copies the cwd dotenv into `process.env` before module init. The startup
 * project snapshot is the declaration set trusted directory overrides use: a
 * path that resolves like that declaration, or a dynamic declaration, is not a
 * spool directory. A shell or `--receipt-spool-dir` value that resolves
 * somewhere else is kept.
 */
function projectDeclaredReceiptSpoolDir(raw: string): boolean {
	const snapshot = loadedProjectEnvSnapshot();
	const key = canonicalEnvKey(RECEIPT_SPOOL_DIR_ENV);
	const projectValue = snapshot.values[key];
	if (projectValue === undefined) return false;
	if (snapshot.dynamic.has(key)) return true;
	const declared = projectValue.trim();
	const candidate = raw.trim();
	if (!declared || !candidate) return declared === candidate;
	return path.resolve(declared) === path.resolve(candidate);
}

function adoptReceiptSpoolDir(raw: string | undefined): string | undefined {
	if (raw === undefined || projectDeclaredReceiptSpoolDir(raw)) return undefined;
	const trimmed = raw.trim();
	return trimmed ? path.resolve(trimmed) : undefined;
}

/** A spool directory the startup project snapshot does not declare. */
export function trustedReceiptSpoolDir(raw: string | undefined): string | undefined {
	return adoptReceiptSpoolDir(raw);
}

interface ReceiptSpoolCursorCache {
	mtimeMs: number;
	size: number;
	highest: bigint;
}

const cursorCache = new Map<string, ReceiptSpoolCursorCache>();
let fullScanCount = 0;

/** @internal Test-only instrumentation for steady-state spool scan coverage. */
export function receiptSpoolFullScanCountForTesting(): number {
	return fullScanCount;
}

/** @internal Test-only cache reset. */
export function resetReceiptSpoolCursorCacheForTesting(): void {
	cursorCache.clear();
	fullScanCount = 0;
}

async function spoolStat(spoolFile: string): Promise<{ mtimeMs: number; size: number } | undefined> {
	try {
		const handle = await fs.open(spoolFile, fsConstants.O_RDONLY | NOFOLLOW);
		try {
			const stats = await handle.stat();
			return { mtimeMs: stats.mtimeMs, size: stats.size };
		} finally {
			await handle.close();
		}
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}
}

function sameSpoolRevision(a: ReceiptSpoolCursorCache, b: { mtimeMs: number; size: number }): boolean {
	return a.mtimeMs === b.mtimeMs && a.size === b.size;
}

async function cacheHighestCursor(spoolFile: string, highest: bigint): Promise<void> {
	const revision = await spoolStat(spoolFile);
	if (revision) cursorCache.set(spoolFile, { ...revision, highest });
}

export async function withReceiptSpoolDir<T>(spoolDir: string, fn: () => Promise<T>): Promise<T> {
	const trimmed = spoolDir.trim();
	if (!trimmed) throw new Error("receipt_spool_dir_empty");
	const resolved = adoptReceiptSpoolDir(trimmed);
	// Owner input repeats process.env. A project-declared directory must not
	// become the active spool via that copy.
	if (!resolved) return fn();
	return receiptSpoolDirStorage.run(resolved, fn);
}

export function resolveReceiptSpoolDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const active = receiptSpoolDirStorage.getStore();
	if (active !== undefined) return active;
	return adoptReceiptSpoolDir(env[RECEIPT_SPOOL_DIR_ENV]);
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
	let handle: fs.FileHandle;
	try {
		handle = await fs.open(spoolFile, fsConstants.O_RDONLY | NOFOLLOW);
	} catch (error) {
		if (isEnoent(error)) {
			cursorCache.delete(spoolFile);
			return 0n;
		}
		throw error;
	}
	try {
		const stats = await handle.stat();
		const revision = { mtimeMs: stats.mtimeMs, size: stats.size };
		const cached = cursorCache.get(spoolFile);
		if (cached && sameSpoolRevision(cached, revision)) return cached.highest;

		fullScanCount++;
		const raw = await handle.readFile({ encoding: "utf8" });
		let highest = 0n;
		for (const line of raw.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				const parsed = JSON.parse(trimmed) as { cursor?: unknown };
				const cursor = parseCursor(parsed.cursor);
				if (cursor !== undefined && cursor > highest) highest = cursor;
			} catch {
				// A crash may leave a torn tail; a full scan ignores it and re-establishes the cache.
			}
		}
		cursorCache.set(spoolFile, { ...revision, highest });
		return highest;
	} finally {
		await handle.close();
	}
}

async function tightenSpoolDir(dir: string): Promise<void> {
	if (process.platform === "win32") return;
	let handle: fs.FileHandle;
	try {
		handle = await fs.open(dir, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | NOFOLLOW);
	} catch {
		return;
	}
	try {
		await handle.chmod(0o700);
	} finally {
		await handle.close();
	}
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
		await tightenSpoolDir(resolvedDir);
		return withFileLock(
			spoolFile,
			async () => {
				const cursor = formatReceiptSpoolCursor((await readHighestReceiptSpoolCursor(resolvedDir)) + 1n);
				const record: ReceiptSpoolRecord = { cursor, envelope };
				const handle = await fs.open(
					spoolFile,
					fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND | NOFOLLOW,
					0o600,
				);
				try {
					if (process.platform !== "win32") await handle.chmod(0o600);
					await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
					await handle.sync();
				} finally {
					await handle.close();
				}
				await cacheHighestCursor(spoolFile, BigInt(cursor));
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
