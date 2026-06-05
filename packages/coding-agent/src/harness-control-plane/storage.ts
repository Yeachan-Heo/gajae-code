/**
 * Session-scoped storage for the harness control plane.
 *
 * Layout (under the harness state root, default `<cwd>/.gjc/state/harness`):
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
import type { EventEnvelope, ReceiptFamily, SessionState } from "./types";

interface HarnessRootRegistryEntry {
	root: string;
	updatedAt: string;
}

interface HarnessRootRegistry {
	sessionId: string;
	roots: HarnessRootRegistryEntry[];
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

/** Resolve the harness state root from explicit value, env, or cwd default. */
export function resolveHarnessRoot(opts?: { root?: string; cwd?: string; env?: NodeJS.ProcessEnv }): string {
	const env = opts?.env ?? process.env;
	if (opts?.root) return path.resolve(opts.root);
	const fromEnv = env.GJC_HARNESS_STATE_ROOT;
	if (fromEnv?.trim()) return path.resolve(fromEnv.trim());
	return path.join(opts?.cwd ?? process.cwd(), ".gjc", "state", "harness");
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

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	const tmp = `${file}.tmp-${randomBytes(4).toString("hex")}`;
	await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	await fs.rename(tmp, file);
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
	await fs.mkdir(paths.dir, { recursive: true });
	await writeJsonAtomic(paths.state, state);
}

export async function sessionExists(root: string, sessionId: string): Promise<boolean> {
	return (await readSessionState(root, sessionId)) !== null;
}

/** Append a single severity envelope to events.jsonl. Single-writer discipline is the owner's job (M3). */
export async function appendEvent(root: string, sessionId: string, envelope: EventEnvelope): Promise<void> {
	const paths = sessionPaths(root, sessionId);
	await fs.mkdir(paths.dir, { recursive: true });
	await fs.appendFile(paths.events, `${JSON.stringify(envelope)}\n`, "utf8");
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
