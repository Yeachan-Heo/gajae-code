/**
 * Session-scoped storage for the harness control plane.
 *
 * Layout (under the harness state root, default `<cwd>/.gjc/_session-{sessionid}/state/harness`):
 *   sessions/<encoded-id>/state.json        lifecycle + handle (atomic)
 *   sessions/<encoded-id>/lease.json         owner lease (M3)
 *   sessions/<encoded-id>/events.jsonl       owner-only severity envelopes
 *   sessions/<encoded-id>/receipts.jsonl     append-only receipt index
 *   sessions/<encoded-id>/receipts/<family>/<receiptId>.json  immutable receipts
 *   sessions/<encoded-id>/artifacts/...      diff/validation artifacts
 *   sessions/<encoded-id>/gjc-session/       underlying gajae-code --session-dir
 *
 * Receipt files are immutable: re-writing an existing receipt id fails closed.
 * JSON writes are atomic (temp + rename).
 */
import { createHash, randomBytes } from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { harnessStateRoot } from "../gjc-runtime/session-layout";
import { appendReceiptToConfiguredSpool } from "./receipt-spool";
import type { ReceiptEnvelope } from "./receipts";
import type { EventEnvelope, ReceiptFamily, SessionState } from "./types";

interface HarnessRootRegistryEntry {
	root: string;
	updatedAt: string;
}

interface HarnessRootRegistry {
	sessionId: string;
	roots: HarnessRootRegistryEntry[];
}

export interface HarnessRootRegistryForGc {
	sessionId: string;
	roots: HarnessRootRegistryEntry[];
}

export interface HarnessRootRegistryListingForGc {
	sessionId: string;
	file: string;
	roots: HarnessRootRegistryEntry[];
	error?: string;
}

interface ResolveHarnessSessionRootOptions {
	expectedWorkspace?: string;
}

export function canonicalWorkspacePath(workspace: string): string {
	return path.resolve(workspace);
}

function samePath(left: string, right: string): boolean {
	return canonicalWorkspacePath(left) === canonicalWorkspacePath(right);
}

async function ensurePrivateDir(dir: string): Promise<void> {
	await fs.mkdir(dir, { recursive: true, mode: 0o700 });
	await fs.chmod(dir, 0o700);
}

function ensurePrivateDirSync(dir: string): void {
	fsSync.mkdirSync(dir, { recursive: true, mode: 0o700 });
	fsSync.chmodSync(dir, 0o700);
}

function sessionMatchesWorkspace(state: SessionState, expectedWorkspace: string): boolean {
	return samePath(state.handle.workspace, expectedWorkspace);
}

function harnessRootRegistryDir(env: NodeJS.ProcessEnv = process.env): string {
	const override = env.GJC_HARNESS_ROOT_REGISTRY_DIR?.trim();
	if (override) return path.resolve(override);
	return path.join(os.tmpdir(), `gjch${process.getuid?.() ?? "u"}`, "harness-roots");
}

function harnessRootRegistryPath(sessionId: string, env: NodeJS.ProcessEnv = process.env): string {
	assertSafeSessionId(sessionId);
	return path.join(harnessRootRegistryDir(env), `${sessionId}.json`);
}

async function readHarnessRootRegistry(
	sessionId: string,
	env: NodeJS.ProcessEnv = process.env,
): Promise<HarnessRootRegistry> {
	const file = harnessRootRegistryPath(sessionId, env);
	try {
		const raw = await fs.readFile(file, "utf8");
		const parsed = JSON.parse(raw) as HarnessRootRegistry;
		if (parsed.sessionId === sessionId && Array.isArray(parsed.roots)) return parsed;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	return { sessionId, roots: [] };
}

async function writeJsonAtomicPrivate(file: string, value: unknown): Promise<void> {
	await ensurePrivateDir(path.dirname(file));
	const tmp = `${file}.tmp-${randomBytes(4).toString("hex")}`;
	await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	await fs.rename(tmp, file);
	await fs.chmod(file, 0o600);
}

async function writeHarnessRootRegistry(
	registry: HarnessRootRegistry,
	env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
	const dir = harnessRootRegistryDir(env);
	await ensurePrivateDir(dir);
	const file = harnessRootRegistryPath(registry.sessionId, env);
	await writeJsonAtomicPrivate(file, registry);
}

function parseHarnessRootRegistryForGc(value: unknown, fallbackSessionId: string): HarnessRootRegistryForGc | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const registry = value as Record<string, unknown>;
	if (typeof registry.sessionId !== "string" || !Array.isArray(registry.roots)) return null;
	const roots: HarnessRootRegistryEntry[] = [];
	for (const entry of registry.roots) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
		const rootEntry = entry as Record<string, unknown>;
		if (typeof rootEntry.root !== "string" || typeof rootEntry.updatedAt !== "string") return null;
		roots.push({ root: rootEntry.root, updatedAt: rootEntry.updatedAt });
	}
	return { sessionId: registry.sessionId || fallbackSessionId, roots };
}

/** @internal */
export async function listHarnessRootRegistriesForGc(
	env: NodeJS.ProcessEnv = process.env,
): Promise<HarnessRootRegistryListingForGc[]> {
	const dir = harnessRootRegistryDir(env);
	let entries: string[];
	try {
		entries = await fs.readdir(dir);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return [];
		return [{ sessionId: "", file: dir, roots: [], error: (error as Error).message }];
	}

	const registries: HarnessRootRegistryListingForGc[] = [];
	for (const entry of entries) {
		if (!entry.endsWith(".json")) continue;
		const file = path.join(dir, entry);
		const fallbackSessionId = entry.slice(0, -".json".length);
		try {
			const raw = await fs.readFile(file, "utf8");
			const parsed = parseHarnessRootRegistryForGc(JSON.parse(raw), fallbackSessionId);
			if (!parsed) {
				registries.push({ sessionId: fallbackSessionId, file, roots: [], error: "malformed_registry" });
				continue;
			}
			registries.push({ sessionId: parsed.sessionId, file, roots: parsed.roots });
		} catch (error) {
			registries.push({ sessionId: fallbackSessionId, file, roots: [], error: (error as Error).message });
		}
	}
	return registries;
}

/** @internal */
export async function rewriteHarnessRootRegistryForGc(file: string, registry: HarnessRootRegistryForGc): Promise<void> {
	await writeJsonAtomicPrivate(file, registry);
}

/** @internal */
export async function removeHarnessRootRegistryFileForGc(file: string): Promise<void> {
	await fs.rm(file, { force: true });
}
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const MAX_UNIX_SOCKET_PATH_BYTES = 100;

interface SocketPathMetadata {
	root: string;
	sessionId: string;
}

function socketBase(env: NodeJS.ProcessEnv, allowOverride: boolean): { base: string; fromOverride: boolean } {
	const override = env.GJC_HARNESS_SOCKET_DIR?.trim();
	if (allowOverride && override) return { base: path.resolve(override), fromOverride: true };
	return { base: path.join(os.tmpdir(), `gjch${process.getuid?.() ?? "u"}`), fromOverride: false };
}

function socketPathForBase(root: string, sessionId: string, base: string): string {
	const digest = createHash("sha256").update(`${root}\0${sessionId}`).digest("hex");
	ensurePrivateDirSync(base);
	for (const len of [16, 24, 32, 48, 64]) {
		const stem = `c-${digest.slice(0, len)}`;
		const metadataPath = path.join(base, `${stem}.json`);
		const metadata: SocketPathMetadata = { root, sessionId };
		try {
			const existing = JSON.parse(fsSync.readFileSync(metadataPath, "utf8")) as SocketPathMetadata;
			if (existing.root === root && existing.sessionId === sessionId) return path.join(base, `${stem}.sock`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			fsSync.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, {
				encoding: "utf8",
				mode: 0o600,
			});
			return path.join(base, `${stem}.sock`);
		}
	}
	throw new StorageError(`socket_path_collision:${sessionId}`, "socket_path_collision");
}

export function controlSocketPath(root: string, sessionId: string, env: NodeJS.ProcessEnv = process.env): string {
	assertSafeSessionId(sessionId);
	let { base, fromOverride } = socketBase(env, true);
	let finalPath = socketPathForBase(root, sessionId, base);
	if (Buffer.byteLength(finalPath) > MAX_UNIX_SOCKET_PATH_BYTES && fromOverride) {
		base = socketBase(env, false).base;
		finalPath = socketPathForBase(root, sessionId, base);
	}
	const finalBytes = Buffer.byteLength(finalPath);
	if (finalBytes > MAX_UNIX_SOCKET_PATH_BYTES) {
		throw new StorageError(`socket_path_too_long:${finalBytes}`, "socket_path_too_long");
	}
	return finalPath;
}

export class StorageError extends Error {
	constructor(
		message: string,
		readonly code: string,
	) {
		super(message);
		this.name = "StorageError";
	}
}

/** Resolve the harness state root from explicit value, env, or cwd/session default. */
export function resolveHarnessRoot(opts?: {
	root?: string;
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	gjcSessionId?: string;
}): string {
	const env = opts?.env ?? process.env;
	if (opts?.root) return path.resolve(opts.root);
	const fromEnv = env.GJC_HARNESS_STATE_ROOT;
	if (fromEnv?.trim()) return path.resolve(fromEnv.trim());
	const gjcSessionId = opts?.gjcSessionId ?? env.GJC_SESSION_ID?.trim();
	if (!gjcSessionId) {
		throw new StorageError("GJC session id is required for default harness state root", "missing_gjc_session_id");
	}
	return harnessStateRoot(opts?.cwd ?? process.cwd(), gjcSessionId);
}

export function assertSafeSessionId(id: string): void {
	if (!SESSION_ID_RE.test(id)) {
		throw new StorageError(`unsafe_session_id:${id}`, "unsafe_session_id");
	}
}

export function generateSessionId(prefix = "h"): string {
	const ts = new Date().toISOString().replace(/[:.]/g, "").replace("T", "-").slice(0, 15);
	const rand = randomBytes(4).toString("hex");
	return `${prefix}-${ts}-${rand}`;
}

export interface SessionPaths {
	dir: string;
	state: string;
	lease: string;
	events: string;
	receiptsIndex: string;
	receiptsDir: string;
	artifactsDir: string;
	controlSock: string;
	controlFifo: string;
	gjcSessionDir: string;
}

export function sessionPaths(root: string, sessionId: string): SessionPaths {
	assertSafeSessionId(sessionId);
	const dir = path.join(root, "sessions", sessionId);
	return {
		dir,
		state: path.join(dir, "state.json"),
		lease: path.join(dir, "lease.json"),
		events: path.join(dir, "events.jsonl"),
		receiptsIndex: path.join(dir, "receipts.jsonl"),
		receiptsDir: path.join(dir, "receipts"),
		artifactsDir: path.join(dir, "artifacts"),
		controlSock: path.join(dir, "control.sock"),
		controlFifo: path.join(dir, "control.fifo"),
		gjcSessionDir: path.join(dir, "gjc-session"),
	};
}

const NO_FOLLOW = process.platform === "win32" ? 0 : (fsSync.constants.O_NOFOLLOW ?? 0);

function errnoCode(error: unknown): string | undefined {
	return error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
}

function sameInode(left: fsSync.BigIntStats, right: fsSync.BigIntStats): boolean {
	return left.dev === right.dev && left.ino === right.ino && left.nlink === right.nlink;
}

/**
 * Leaf directory mode 0700. `lstat` plus `chmod` does not need read permission, so a
 * mode 0300 directory stays writable. A symlink leaf is refused before chmod.
 * This does not pin the directory against a later rename in a writable parent.
 */
async function ensureOwnerDirectory(dir: string): Promise<void> {
	await fs.mkdir(dir, { recursive: true, mode: 0o700 });
	let current: fsSync.Stats;
	try {
		current = await fs.lstat(dir);
	} catch (error) {
		const code = errnoCode(error);
		if (code === "ELOOP" || code === "ENOTDIR") throw new Error("harness state directory is not a directory");
		throw error;
	}
	if (current.isSymbolicLink() || !current.isDirectory())
		throw new Error("harness state directory is not a directory");
	if (process.platform === "win32" || (current.mode & 0o077) === 0) return;
	await fs.chmod(dir, 0o700);
	const tightened = await fs.lstat(dir);
	if (tightened.isSymbolicLink() || !tightened.isDirectory() || (tightened.mode & 0o777) !== 0o700) {
		throw new Error("harness state directory could not be tightened to mode 0700");
	}
}

async function assertRegularOrMissing(file: string): Promise<void> {
	try {
		const existing = await fs.lstat(file);
		if (existing.isSymbolicLink() || !existing.isFile()) throw new Error("harness state path is not a regular file");
	} catch (error) {
		if (errnoCode(error) !== "ENOENT") throw error;
	}
}

/**
 * Append like the workflow owner-only writer: mode 0600, `O_NOFOLLOW` when the file
 * exists, `O_EXCL` when it does not, and chmod to 0600 when group or other bits are set.
 */
async function appendOwnerOnly(filePath: string, text: string): Promise<void> {
	await ensureOwnerDirectory(path.dirname(filePath));
	let handle: fs.FileHandle | undefined;
	let initial: fsSync.BigIntStats | undefined;
	for (let attempt = 0; attempt < 2; attempt++) {
		initial = undefined;
		try {
			initial = await fs.lstat(filePath, { bigint: true });
			if (initial.isSymbolicLink() || !initial.isFile()) throw new Error("harness state path is not a regular file");
		} catch (error) {
			if (errnoCode(error) !== "ENOENT") throw error;
		}
		const flags = initial
			? fsSync.constants.O_WRONLY | fsSync.constants.O_APPEND | NO_FOLLOW
			: fsSync.constants.O_WRONLY | fsSync.constants.O_APPEND | fsSync.constants.O_CREAT | fsSync.constants.O_EXCL;
		try {
			handle = await fs.open(filePath, flags, 0o600);
			break;
		} catch (error) {
			const code = errnoCode(error);
			if (code === "ELOOP") throw new Error("harness state path is not a regular file");
			if (initial === undefined && code === "EEXIST" && attempt === 0) continue;
			throw error;
		}
	}
	if (!handle) throw new Error("harness state path identity changed before append");
	try {
		const opened = await handle.stat({ bigint: true });
		const named = await fs.lstat(filePath, { bigint: true });
		if (
			opened.isSymbolicLink() ||
			!opened.isFile() ||
			named.isSymbolicLink() ||
			!named.isFile() ||
			(initial !== undefined && !sameInode(initial, opened)) ||
			!sameInode(opened, named)
		) {
			throw new Error("harness state path identity changed before append");
		}
		if (process.platform !== "win32" && (Number(opened.mode) & 0o077) !== 0) {
			await handle.chmod(0o600);
			const tightened = await handle.stat({ bigint: true });
			if ((Number(tightened.mode) & 0o777) !== 0o600) {
				throw new Error("harness state path could not be tightened to mode 0600");
			}
		}
		await handle.writeFile(text, "utf8");
	} finally {
		await handle.close();
	}
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
	await ensureOwnerDirectory(path.dirname(file));
	await assertRegularOrMissing(file);
	const tmp = `${file}.tmp-${randomBytes(4).toString("hex")}`;
	const flags = fsSync.constants.O_WRONLY | fsSync.constants.O_CREAT | fsSync.constants.O_EXCL | NO_FOLLOW;
	const handle = await fs.open(tmp, flags, 0o600);
	try {
		if (process.platform !== "win32") {
			await handle.chmod(0o600);
			const created = await handle.stat();
			if (!created.isFile() || (created.mode & 0o777) !== 0o600) {
				throw new Error("harness state path could not be tightened to mode 0600");
			}
		}
		await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
	} finally {
		await handle.close();
	}
	try {
		await assertRegularOrMissing(file);
		await fs.rename(tmp, file);
	} catch (error) {
		await fs.rm(tmp, { force: true }).catch(() => undefined);
		throw error;
	}
}

async function readJson<T>(file: string): Promise<T | null> {
	try {
		const raw = await fs.readFile(file, "utf8");
		return JSON.parse(raw) as T;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}
function isReceiptEnvelope(value: unknown): value is ReceiptEnvelope<unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const envelope = value as Record<string, unknown>;
	return (
		typeof envelope.receiptId === "string" &&
		typeof envelope.schemaVersion === "number" &&
		typeof envelope.sessionId === "string" &&
		typeof envelope.family === "string" &&
		typeof envelope.valid === "boolean" &&
		typeof envelope.createdAt === "string" &&
		typeof envelope.source === "string" &&
		envelope.subject !== null &&
		typeof envelope.subject === "object" &&
		envelope.evidence !== null &&
		typeof envelope.evidence === "object" &&
		envelope.artifactHashes !== null &&
		typeof envelope.artifactHashes === "object" &&
		typeof envelope.sha256 === "string"
	);
}

export async function readSessionState(root: string, sessionId: string): Promise<SessionState | null> {
	return readJson<SessionState>(sessionPaths(root, sessionId).state);
}
export async function rememberHarnessSessionRoot(
	root: string,
	sessionId: string,
	env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
	assertSafeSessionId(sessionId);
	const resolvedRoot = path.resolve(root);
	const registry = await readHarnessRootRegistry(sessionId, env);
	const now = new Date().toISOString();
	registry.roots = [
		{ root: resolvedRoot, updatedAt: now },
		...registry.roots.filter(entry => path.resolve(entry.root) !== resolvedRoot),
	].slice(0, 8);
	await writeHarnessRootRegistry(registry, env);
}

export async function resolveHarnessSessionRoot(
	root: string,
	sessionId: string,
	env: NodeJS.ProcessEnv = process.env,
	options: ResolveHarnessSessionRootOptions = {},
): Promise<string> {
	assertSafeSessionId(sessionId);
	const resolvedRoot = path.resolve(root);
	const candidates: { root: string; state: SessionState }[] = [];
	const seenRoots = new Set<string>();
	const addCandidate = async (candidateRoot: string): Promise<void> => {
		const candidate = path.resolve(candidateRoot);
		if (seenRoots.has(candidate)) return;
		seenRoots.add(candidate);
		const state = await readSessionState(candidate, sessionId);
		if (state !== null) candidates.push({ root: candidate, state });
	};

	await addCandidate(resolvedRoot);
	const registry = await readHarnessRootRegistry(sessionId, env);
	for (const entry of registry.roots) await addCandidate(entry.root);

	if (!options.expectedWorkspace) {
		if (candidates.some(candidate => candidate.root === resolvedRoot)) return resolvedRoot;
		if (candidates.length === 1) return candidates[0].root;
		if (candidates.length > 1) {
			throw new StorageError(`ambiguous_harness_session_root:${sessionId}`, "ambiguous_harness_session_root");
		}
		return resolvedRoot;
	}

	const expectedWorkspace = canonicalWorkspacePath(options.expectedWorkspace);
	const matchingCandidates = candidates.filter(candidate =>
		sessionMatchesWorkspace(candidate.state, expectedWorkspace),
	);
	if (matchingCandidates.length === 1) return matchingCandidates[0].root;
	if (matchingCandidates.length > 1) {
		throw new StorageError(`ambiguous_harness_session_root:${sessionId}`, "ambiguous_harness_session_root");
	}
	if (candidates.length > 0) {
		throw new StorageError(`session_workspace_mismatch:${sessionId}`, "session_workspace_mismatch");
	}
	return resolvedRoot;
}

export async function writeSessionState(root: string, state: SessionState): Promise<void> {
	const paths = sessionPaths(root, state.sessionId);
	await writeJsonAtomic(paths.state, state);
}

export async function sessionExists(root: string, sessionId: string): Promise<boolean> {
	return (await readSessionState(root, sessionId)) !== null;
}

/** Append a single severity envelope to events.jsonl. Single-writer discipline is the owner's job (M3). */
export async function appendEvent(root: string, sessionId: string, envelope: EventEnvelope): Promise<void> {
	const paths = sessionPaths(root, sessionId);
	await appendOwnerOnly(paths.events, `${JSON.stringify(envelope)}\n`);
}

/** Read events from cursor (exclusive). Tail-only: never mutates the log. */
export async function readEvents(root: string, sessionId: string, fromCursor = 0): Promise<EventEnvelope[]> {
	const paths = sessionPaths(root, sessionId);
	let raw: string;
	try {
		raw = await fs.readFile(paths.events, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const out: EventEnvelope[] = [];
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const env = JSON.parse(trimmed) as EventEnvelope;
		if (env.cursor > fromCursor) out.push(env);
	}
	return out;
}

export interface ReceiptIndexEntry {
	receiptId: string;
	family: ReceiptFamily;
	valid: boolean;
	createdAt: string;
	path: string;
}

/**
 * Persist a receipt immutably. Fails closed if the receipt id already exists,
 * then appends an index entry to receipts.jsonl.
 */
export async function writeReceiptImmutable(
	root: string,
	sessionId: string,
	family: ReceiptFamily,
	receiptId: string,
	value: { receiptId: string; family: ReceiptFamily; valid: boolean; createdAt: string },
): Promise<ReceiptIndexEntry> {
	assertSafeSessionId(sessionId);
	if (!SESSION_ID_RE.test(receiptId)) {
		throw new StorageError(`unsafe_receipt_id:${receiptId}`, "unsafe_receipt_id");
	}
	const paths = sessionPaths(root, sessionId);
	const familyDir = path.join(paths.receiptsDir, family);
	const file = path.join(familyDir, `${receiptId}.json`);
	await fs.mkdir(familyDir, { recursive: true });
	try {
		await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			throw new StorageError(`receipt_immutable_conflict:${family}/${receiptId}`, "receipt_immutable_conflict");
		}
		throw error;
	}
	const entry: ReceiptIndexEntry = {
		receiptId,
		family,
		valid: value.valid,
		createdAt: value.createdAt,
		path: file,
	};
	await fs.appendFile(paths.receiptsIndex, `${JSON.stringify(entry)}\n`, "utf8");
	if (isReceiptEnvelope(value)) await appendReceiptToConfiguredSpool(value);
	return entry;
}

export async function readReceiptIndex(
	root: string,
	sessionId: string,
	family?: ReceiptFamily,
): Promise<ReceiptIndexEntry[]> {
	const paths = sessionPaths(root, sessionId);
	let raw: string;
	try {
		raw = await fs.readFile(paths.receiptsIndex, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const out: ReceiptIndexEntry[] = [];
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const entry = JSON.parse(trimmed) as ReceiptIndexEntry;
		if (!family || entry.family === family) out.push(entry);
	}
	return out;
}
