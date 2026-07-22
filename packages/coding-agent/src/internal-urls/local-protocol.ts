import { createHash, randomUUID } from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { exactRemoveDirectoryTree, type NativeDirectoryTreeSnapshot, snapshotDirectoryTree } from "@gajae-code/natives";
import { isEnoent } from "@gajae-code/utils";
import { AgentRegistry } from "../registry/agent-registry";
import { parseInternalUrl } from "./parse";
import { validateRelativePath } from "./skill-protocol";
import type { InternalResource, InternalUrl, ProtocolHandler } from "./types";

export interface ManagedLegacyLocalMigrationEntry {
	readonly relativePath: string;
	readonly kind: "directory" | "file";
	readonly bytes?: Uint8Array;
	readonly sha256?: string;
}

/** Opaque authority for a managed session's legacy `local` artifact tree. */
export interface ManagedLegacyLocalMigrationSource {
	capture(): Promise<{
		readonly snapshot: NativeDirectoryTreeSnapshot;
		readonly entries: readonly ManagedLegacyLocalMigrationEntry[];
	} | null>;
	retire(snapshot: NativeDirectoryTreeSnapshot): void;
}

export interface LocalProtocolOptions {
	getArtifactsDir?: () => string | null;
	isManagedDestination?: () => boolean;
	getManagedLegacyLocalMigrationSource?: () => ManagedLegacyLocalMigrationSource | null;
	getSessionId?: () => string | null;
}

function parseLocalUrl(input: string): InternalUrl {
	return parseInternalUrl(input);
}

function ensureWithinRoot(targetPath: string, rootPath: string): void {
	if (targetPath !== rootPath && !targetPath.startsWith(`${rootPath}${path.sep}`)) {
		throw new Error("local:// URL escapes local root");
	}
}

function toLocalValidationError(error: unknown): Error {
	const message = error instanceof Error ? error.message : String(error);
	return new Error(message.replace("skill://", "local://"));
}

function getContentType(filePath: string): InternalResource["contentType"] {
	const ext = path.extname(filePath).toLowerCase();
	if (ext === ".md") return "text/markdown";
	if (ext === ".json") return "application/json";
	return "text/plain";
}

async function listFilesRecursively(rootPath: string): Promise<string[]> {
	const pending = [""];
	const files: string[] = [];

	while (pending.length > 0) {
		const relativeDir = pending.pop();
		if (relativeDir === undefined) continue;
		const absoluteDir = path.join(rootPath, relativeDir);
		const entries = await fs.readdir(absoluteDir, { withFileTypes: true });

		for (const entry of entries) {
			if (entry.name === LEGACY_MIGRATION_MARKER) continue;
			const entryPath = path.join(relativeDir, entry.name);
			if (entry.isDirectory()) {
				pending.push(entryPath);
				continue;
			}
			if (entry.isFile()) {
				files.push(entryPath.replaceAll(path.sep, "/"));
			}
		}
	}

	return files.sort((a, b) => a.localeCompare(b));
}

async function buildListing(url: InternalUrl, localRoot: string): Promise<InternalResource> {
	const files = await listFilesRecursively(localRoot);
	const listing = files.length === 0 ? "(empty)" : files.map(file => `- [${file}](local://${file})`).join("\n");
	const content =
		`# Local\n\n` +
		`Session-scoped scratch space for large intermediate data, subagent handoffs, and reusable planning artifacts.\n\n` +
		`Root: ${localRoot}\n\n` +
		`${files.length} file${files.length === 1 ? "" : "s"} available:\n\n` +
		`${listing}\n`;

	return {
		url: url.href,
		content,
		contentType: "text/markdown",
		size: Buffer.byteLength(content, "utf-8"),
		sourcePath: localRoot,
	};
}

function extractRelativePath(url: InternalUrl): string {
	const host = url.rawHost || url.hostname;
	const pathname = url.rawPathname ?? url.pathname;

	const combined = host
		? pathname && pathname !== "/"
			? `${host}${pathname}`
			: host
		: pathname && pathname !== "/"
			? pathname.slice(1)
			: "";

	if (!combined) {
		return "";
	}

	let decoded: string;
	try {
		decoded = decodeURIComponent(combined.replaceAll("\\", "/"));
	} catch {
		throw new Error(`Invalid URL encoding in local:// path: ${url.href}`);
	}
	try {
		validateRelativePath(decoded);
	} catch (error) {
		throw toLocalValidationError(error);
	}
	return decoded;
}

function safeSessionId(options: LocalProtocolOptions): string {
	const sessionId = (options.getSessionId?.() ?? "session").replace(/[^a-zA-Z0-9_.-]/g, "_");
	return sessionId === "" || sessionId === "." || sessionId === ".." ? "session" : sessionId;
}

async function assertDirectoryNotSymlink(directoryPath: string): Promise<void> {
	const stat = await fs.lstat(directoryPath);
	if (!stat.isDirectory() || stat.isSymbolicLink()) {
		throw new Error("Unsafe local:// root");
	}
}

const LEGACY_MIGRATION_MARKER = ".gjc-local-legacy-migrated-v1";
const MAX_LEGACY_LOCAL_BYTES = 64 * 1024 * 1024;

interface LegacyEntrySnapshot {
	readonly relativePath: string;
	readonly dev: bigint;
	readonly ino: bigint;
	readonly size: bigint;
	readonly digest?: string;
	readonly bytes?: Buffer;
}
interface LegacyIdentityStat {
	readonly dev: bigint;
	readonly ino: bigint;
	readonly size: bigint;
}

function matchesSnapshot(stat: LegacyIdentityStat, snapshot: LegacyEntrySnapshot): boolean {
	return stat.dev === snapshot.dev && stat.ino === snapshot.ino && stat.size === snapshot.size;
}

async function snapshotDirectory(directoryPath: string, relativePath: string): Promise<LegacyEntrySnapshot> {
	const stat = await fs.lstat(directoryPath, { bigint: true });
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe legacy local:// migration source");
	return { relativePath, dev: stat.dev, ino: stat.ino, size: stat.size };
}

interface CanonicalLegacyRoot {
	readonly root: string;
	readonly identity: LegacyEntrySnapshot;
}

async function canonicalLegacyRoot(artifactsDir: string): Promise<CanonicalLegacyRoot> {
	const lexicalRoot = path.resolve(artifactsDir, "local");
	const lexicalIdentity = await snapshotDirectory(lexicalRoot, "");
	const [canonicalArtifactsDir, canonicalRoot] = await Promise.all([
		fs.realpath(path.resolve(artifactsDir)),
		fs.realpath(lexicalRoot),
	]);
	if (canonicalRoot === canonicalArtifactsDir) throw new Error("Unsafe legacy local:// migration source");
	ensureWithinRoot(canonicalRoot, canonicalArtifactsDir);
	const canonicalIdentity = await snapshotDirectory(canonicalRoot, "");
	if (!matchesSnapshot(canonicalIdentity, lexicalIdentity))
		throw new Error("Legacy local:// migration source changed during capture");
	return { root: canonicalRoot, identity: lexicalIdentity };
}

async function snapshotRegularFile(filePath: string, relativePath: string): Promise<LegacyEntrySnapshot> {
	const before = await fs.lstat(filePath, { bigint: true });
	if (!before.isFile() || before.isSymbolicLink()) throw new Error("Unsafe legacy local:// migration source");
	const flags = fsSync.constants.O_RDONLY | (process.platform === "win32" ? 0 : (fsSync.constants.O_NOFOLLOW ?? 0));
	const handle = await fs.open(filePath, flags);
	try {
		const opened = await handle.stat({ bigint: true });
		const identity = { relativePath, dev: before.dev, ino: before.ino, size: before.size };
		if (!opened.isFile() || !matchesSnapshot(opened, identity))
			throw new Error("Legacy local:// migration source changed during capture");
		const bytes = await handle.readFile();
		const after = await fs.lstat(filePath, { bigint: true });
		if (!matchesSnapshot(after, identity)) throw new Error("Legacy local:// migration source changed during capture");
		return { ...identity, digest: createHash("sha256").update(bytes).digest("hex"), bytes };
	} finally {
		await handle.close();
	}
}

function manifestsMatch(left: readonly LegacyEntrySnapshot[], right: readonly LegacyEntrySnapshot[]): boolean {
	return (
		left.length === right.length &&
		left.every(
			(entry, index) =>
				entry.relativePath === right[index]?.relativePath &&
				entry.dev === right[index]?.dev &&
				entry.ino === right[index]?.ino &&
				entry.size === right[index]?.size &&
				entry.digest === right[index]?.digest,
		)
	);
}

async function captureLegacyManifest(
	root: string,
	expectedRootIdentity: LegacyEntrySnapshot,
): Promise<readonly LegacyEntrySnapshot[]> {
	const manifest: LegacyEntrySnapshot[] = [];
	let copiedBytes = 0n;
	const captureDirectory = async (directoryPath: string, relativePath: string): Promise<void> => {
		const directory = await snapshotDirectory(directoryPath, relativePath);
		if (relativePath === "" && !matchesSnapshot(directory, expectedRootIdentity))
			throw new Error("Legacy local:// migration source changed during capture");
		manifest.push(directory);
		const entries = (await fs.readdir(directoryPath, { withFileTypes: true })).sort((a, b) =>
			a.name.localeCompare(b.name),
		);
		for (const entry of entries) {
			const entryPath = path.join(directoryPath, entry.name);
			const entryRelativePath = path.join(relativePath, entry.name);
			if (entry.name === LEGACY_MIGRATION_MARKER) throw new Error("Unsafe legacy local:// migration source");
			if (entry.isDirectory()) await captureDirectory(entryPath, entryRelativePath);
			else {
				const file = await snapshotRegularFile(entryPath, entryRelativePath);
				copiedBytes += file.size;
				if (copiedBytes > BigInt(MAX_LEGACY_LOCAL_BYTES))
					throw new Error("Legacy local:// migration exceeds the safe size limit");
				manifest.push(file);
			}
		}
		const after = await fs.lstat(directoryPath, { bigint: true });
		if (!matchesSnapshot(after, directory))
			throw new Error("Legacy local:// migration source changed during capture");
	};
	await captureDirectory(root, "");
	return manifest;
}

async function copyLegacyManifest(
	source: string,
	destination: string,
	manifest: readonly LegacyEntrySnapshot[],
): Promise<void> {
	for (const entry of manifest) {
		if (entry.relativePath === "") {
			await fs.mkdir(destination, { mode: 0o700 });
			continue;
		}
		const from = path.join(source, entry.relativePath);
		const to = path.join(destination, entry.relativePath);
		if (entry.digest === undefined) {
			await fs.mkdir(to, { mode: 0o700 });
			continue;
		}
		const captured = await snapshotRegularFile(from, entry.relativePath);
		if (captured.digest !== entry.digest || !matchesSnapshot(captured, entry))
			throw new Error("Legacy local:// migration source changed during capture");
		if (entry.bytes === undefined) throw new Error("Legacy local:// migration snapshot is incomplete");
		await fs.writeFile(to, entry.bytes, { mode: 0o600, flag: "wx" });
		const copied = await fs.readFile(to);
		if (createHash("sha256").update(copied).digest("hex") !== entry.digest)
			throw new Error("Legacy local:// migration destination verification failed");
	}
}

async function retireLegacyTree(legacyRoot: string, manifest: readonly LegacyEntrySnapshot[]): Promise<void> {
	const root = manifest[0];
	if (root?.relativePath !== "") throw new Error("Legacy local:// migration manifest has no root");
	const before = await fs.lstat(legacyRoot, { bigint: true });
	if (!matchesSnapshot(before, root)) throw new Error("Legacy local:// migration source changed during retirement");
	const captured = snapshotDirectoryTree(legacyRoot);
	if (!captured.ok || !captured.snapshot) {
		throw new Error(`Legacy local:// migration retirement snapshot failed: ${captured.code ?? "unknown"}`);
	}
	if (captured.snapshot.entries.length !== manifest.length) {
		throw new Error("Legacy local:// migration retirement manifest changed");
	}
	const expected = new Map(manifest.map(entry => [entry.relativePath.replaceAll(path.sep, "/"), entry]));
	for (const entry of captured.snapshot.entries) {
		const original = expected.get(entry.relativePath);
		if (
			!original ||
			entry.dev !== original.dev.toString() ||
			entry.ino !== original.ino.toString() ||
			entry.size !== original.size.toString() ||
			(entry.kind === "file" ? entry.sha256 !== original.digest : original.digest !== undefined)
		) {
			throw new Error("Legacy local:// migration retirement authority differs from copied manifest");
		}
	}
	const removed = exactRemoveDirectoryTree(legacyRoot, captured.snapshot);
	if (!removed.ok) throw new Error(`Legacy local:// migration retirement failed: ${removed.code}`);
}
async function migrateManagedLegacyLocal(
	source: ManagedLegacyLocalMigrationSource,
	localRoot: string,
	scratchParent: string,
	marker: string,
): Promise<void> {
	const captured = await source.capture();
	if (!captured) {
		await fs.writeFile(marker, "absent\n", { mode: 0o600, flag: "wx" });
		return;
	}
	let copiedBytes = 0;
	for (const entry of captured.entries) {
		if (entry.kind === "file") {
			if (!entry.bytes || !entry.sha256) throw new Error("Legacy local:// migration snapshot is incomplete");
			copiedBytes += entry.bytes.byteLength;
			if (copiedBytes > MAX_LEGACY_LOCAL_BYTES)
				throw new Error("Legacy local:// migration exceeds the safe size limit");
		}
	}
	const staging = path.join(scratchParent, `.gjc-local-migration-${randomUUID()}`);
	const installed: Array<{ readonly path: string; readonly dev: bigint; readonly ino: bigint }> = [];
	let installedMarker: { readonly dev: bigint; readonly ino: bigint } | null = null;
	try {
		await fs.mkdir(staging, { mode: 0o700 });
		for (const entry of captured.entries) {
			if (entry.relativePath === "") continue;
			const target = path.join(staging, entry.relativePath);
			if (entry.kind === "directory") await fs.mkdir(target, { mode: 0o700 });
			else {
				await fs.writeFile(target, entry.bytes!, { mode: 0o600, flag: "wx" });
				const copied = await fs.readFile(target);
				if (createHash("sha256").update(copied).digest("hex") !== entry.sha256)
					throw new Error("Legacy local:// migration destination verification failed");
			}
		}
		for (const entry of await fs.readdir(staging)) {
			const destination = path.join(localRoot, entry);
			try {
				await fs.lstat(destination);
				throw new Error("Legacy local:// migration destination is ambiguous");
			} catch (error) {
				if (!isEnoent(error)) throw error;
			}
			await fs.rename(path.join(staging, entry), destination);
			const identity = await fs.lstat(destination, { bigint: true });
			installed.push({ path: destination, dev: identity.dev, ino: identity.ino });
		}
		await fs.writeFile(marker, "verified\n", { mode: 0o600, flag: "wx" });
		const markerIdentity = await fs.lstat(marker, { bigint: true });
		installedMarker = { dev: markerIdentity.dev, ino: markerIdentity.ino };
		source.retire(captured.snapshot);
	} catch (error) {
		const currentMarker = await fs.lstat(marker, { bigint: true }).catch(() => null);
		if (installedMarker && currentMarker?.dev === installedMarker.dev && currentMarker.ino === installedMarker.ino)
			await fs.rm(marker, { force: true });
		for (const destination of installed.reverse()) {
			const current = await fs.lstat(destination.path, { bigint: true }).catch(() => null);
			if (current?.dev === destination.dev && current.ino === destination.ino)
				await fs.rm(destination.path, { recursive: true, force: true });
		}
		throw error;
	} finally {
		await fs.rm(staging, { recursive: true, force: true });
	}
}

async function readMigrationMarker(marker: string): Promise<boolean> {
	try {
		const snapshot = await snapshotRegularFile(marker, LEGACY_MIGRATION_MARKER);
		if (snapshot.size > 32n || snapshot.bytes === undefined) throw new Error("Unsafe local:// migration marker");
		const value = snapshot.bytes.toString("utf8");
		if (value !== "verified\n" && value !== "absent\n") throw new Error("Unsafe local:// migration marker");
		return true;
	} catch (error) {
		if (isEnoent(error)) return false;
		throw error;
	}
}

async function migrateLegacyLocal(
	options: LocalProtocolOptions,
	localRoot: string,
	scratchParent: string,
): Promise<void> {
	const marker = path.join(localRoot, LEGACY_MIGRATION_MARKER);
	if (await readMigrationMarker(marker)) return;
	const managedSource = options.getManagedLegacyLocalMigrationSource?.();
	if (managedSource) {
		await migrateManagedLegacyLocal(managedSource, localRoot, scratchParent, marker);
		return;
	}
	const artifactsDir = options.getArtifactsDir?.();
	if (!artifactsDir) {
		await fs.writeFile(marker, "absent\n", { mode: 0o600, flag: "wx" });
		return;
	}
	let legacySource: CanonicalLegacyRoot;
	let manifest: readonly LegacyEntrySnapshot[];
	try {
		legacySource = await canonicalLegacyRoot(artifactsDir);
		manifest = await captureLegacyManifest(legacySource.root, legacySource.identity);
	} catch (error) {
		if (isEnoent(error)) {
			await fs.writeFile(marker, "absent\n", { mode: 0o600, flag: "wx" });
			return;
		}
		throw error;
	}
	const staging = path.join(scratchParent, `.gjc-local-migration-${randomUUID()}`);
	try {
		await copyLegacyManifest(legacySource.root, staging, manifest);
		const verifiedManifest = await captureLegacyManifest(legacySource.root, legacySource.identity);
		if (!manifestsMatch(verifiedManifest, manifest))
			throw new Error("Legacy local:// migration source changed during capture");
		for (const entry of await fs.readdir(staging)) {
			try {
				await fs.lstat(path.join(localRoot, entry));
				throw new Error("Legacy local:// migration destination is ambiguous");
			} catch (error) {
				if (!isEnoent(error)) throw error;
			}
			await fs.rename(path.join(staging, entry), path.join(localRoot, entry));
		}
		await retireLegacyTree(legacySource.root, manifest);
		await fs.writeFile(marker, "verified\n", { mode: 0o600, flag: "wx" });
	} finally {
		await fs.rm(staging, { recursive: true, force: true });
	}
}

const initializedLocalRoots = new Set<string>();

/**
 * Completes the mandatory legacy migration gate for a local root.
 * Call and await this before using the synchronous path resolver for reads or writes.
 */
function explicitLocalRoot(options: LocalProtocolOptions): string | null {
	if (options.isManagedDestination?.()) return null;
	const artifactsDir = options.getArtifactsDir?.();
	return artifactsDir ? path.resolve(artifactsDir, "local") : null;
}

async function initializeExplicitLocalRoot(localRoot: string): Promise<string> {
	await fs.mkdir(path.dirname(localRoot), { recursive: true });
	await assertDirectoryNotSymlink(path.dirname(localRoot));
	await fs.mkdir(localRoot, { recursive: true });
	await assertDirectoryNotSymlink(localRoot);
	return await fs.realpath(localRoot);
}

function initializeExplicitLocalRootSync(localRoot: string): string {
	fsSync.mkdirSync(path.dirname(localRoot), { recursive: true });
	const parentStat = fsSync.lstatSync(path.dirname(localRoot));
	if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error("Unsafe local:// root");
	fsSync.mkdirSync(localRoot, { recursive: true });
	const rootStat = fsSync.lstatSync(localRoot);
	if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Unsafe local:// root");
	return fsSync.realpathSync(localRoot);
}

export async function initializeLocalRoot(options: LocalProtocolOptions): Promise<string> {
	const explicitRoot = explicitLocalRoot(options);
	if (explicitRoot) return await initializeExplicitLocalRoot(explicitRoot);
	const localRoot = path.resolve(resolveLocalRoot(options));
	const scratchParent = path.dirname(localRoot);

	await fs.mkdir(scratchParent, { recursive: true, mode: 0o700 });
	await assertDirectoryNotSymlink(scratchParent);
	try {
		await fs.mkdir(localRoot, { mode: 0o700 });
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "EEXIST") {
			await assertDirectoryNotSymlink(localRoot);
		} else {
			throw error;
		}
	}
	await assertDirectoryNotSymlink(localRoot);
	await migrateLegacyLocal(options, localRoot, scratchParent);

	const resolvedScratchParent = await fs.realpath(scratchParent);
	const resolvedLocalRoot = await fs.realpath(localRoot);
	ensureWithinRoot(resolvedLocalRoot, resolvedScratchParent);
	if (resolvedLocalRoot === resolvedScratchParent) {
		throw new Error("Unsafe local:// root");
	}
	initializedLocalRoots.add(resolvedLocalRoot);
	return resolvedLocalRoot;
}

function initializeLocalRootSyncWhenLegacyAbsent(options: LocalProtocolOptions, localRoot: string): void {
	const explicitRoot = explicitLocalRoot(options);
	if (explicitRoot) {
		initializeExplicitLocalRootSync(explicitRoot);
		return;
	}
	if (initializedLocalRoots.has(localRoot)) return;
	const scratchParent = path.dirname(localRoot);
	fsSync.mkdirSync(scratchParent, { recursive: true, mode: 0o700 });
	const parentStat = fsSync.lstatSync(scratchParent);
	if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error("Unsafe local:// root");
	try {
		fsSync.mkdirSync(localRoot, { mode: 0o700 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	const rootStat = fsSync.lstatSync(localRoot);
	if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Unsafe local:// root");
	const marker = path.join(localRoot, LEGACY_MIGRATION_MARKER);
	try {
		const value = fsSync.readFileSync(marker, "utf8");
		if (value !== "verified\n" && value !== "absent\n") throw new Error("Unsafe local:// migration marker");
		initializedLocalRoots.add(localRoot);
		return;
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
	if (options.getManagedLegacyLocalMigrationSource?.()) {
		throw new Error("local:// legacy migration must complete before path resolution");
	}
	const artifactsDir = options.getArtifactsDir?.();
	if (artifactsDir && fsSync.existsSync(path.resolve(artifactsDir, "local"))) {
		throw new Error("local:// legacy migration must complete before path resolution");
	}
	try {
		fsSync.writeFileSync(marker, "absent\n", { mode: 0o600, flag: "wx" });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		if (fsSync.readFileSync(marker, "utf8") !== "absent\n") throw new Error("Unsafe local:// migration marker");
	}
	initializedLocalRoots.add(localRoot);
}

export function resolveLocalRoot(options: LocalProtocolOptions): string {
	return explicitLocalRoot(options) ?? path.join(os.tmpdir(), "gjc-local", safeSessionId(options));
}

export function resolveLocalUrlToPath(input: string | InternalUrl, options: LocalProtocolOptions): string {
	const url = typeof input === "string" ? parseLocalUrl(input) : input;
	const localRoot = path.resolve(resolveLocalRoot(options));
	initializeLocalRootSyncWhenLegacyAbsent(options, localRoot);
	const relativePath = extractRelativePath(url);

	if (!relativePath) {
		return localRoot;
	}

	const resolved = path.resolve(localRoot, relativePath);
	ensureWithinRoot(resolved, localRoot);
	return resolved;
}

/**
 * Protocol handler for local:// URLs.
 *
 * URL forms:
 * - local:// - Lists files at the session local root
 * - local://<path> - Reads a file under the session local root
 */
export class LocalProtocolHandler implements ProtocolHandler {
	readonly scheme = "local";
	readonly immutable = false;

	static #override: LocalProtocolOptions | undefined;
	static #ownedOverrides: Array<{ options: LocalProtocolOptions }> = [];

	/**
	 * Install an explicit local-protocol mapping owned by the caller.
	 *
	 * The most recently installed live mapping wins. The returned disposer removes
	 * only this registration and is safe to call more than once.
	 */
	static installOverride(value: LocalProtocolOptions): () => void {
		const registration = { options: value };
		LocalProtocolHandler.#ownedOverrides.push(registration);
		let disposed = false;
		return () => {
			if (disposed) return;
			disposed = true;
			const index = LocalProtocolHandler.#ownedOverrides.indexOf(registration);
			if (index !== -1) LocalProtocolHandler.#ownedOverrides.splice(index, 1);
		};
	}

	/**
	 * Install a process-global test override that wins over owned and registry
	 * mappings. Prefer {@link installOverride} for lifecycle-bound production use.
	 */
	static setOverride(value: LocalProtocolOptions | undefined): void {
		LocalProtocolHandler.#override = value;
	}

	/** Reset all process-global local-protocol overrides. Test-only. */
	static resetOverrideForTests(): void {
		LocalProtocolHandler.#override = undefined;
		LocalProtocolHandler.#ownedOverrides = [];
		initializedLocalRoots.clear();
	}

	/**
	 * Returns the active local-protocol options.
	 *
	 * Resolution order:
	 * 1. Direct test override installed via {@link setOverride}.
	 * 2. The most recently installed live owned override.
	 * 3. A live main session in `AgentRegistry.global()`.
	 */
	static resolveOptions(): LocalProtocolOptions | undefined {
		const override = LocalProtocolHandler.#override;
		if (override) return override;
		const ownedOverride = LocalProtocolHandler.#ownedOverrides.at(-1)?.options;
		if (ownedOverride) return ownedOverride;
		const main = AgentRegistry.global()
			.list()
			.find(ref => ref.kind === "main" && ref.session && (ref.status === "running" || ref.status === "idle"));
		const sessionManager = main?.session?.sessionManager;
		if (!sessionManager) return undefined;
		return {
			getArtifactsDir: () => sessionManager.getArtifactsDir(),
			isManagedDestination: () => sessionManager.isManagedDestination(),
			getManagedLegacyLocalMigrationSource: () => sessionManager.getManagedLegacyLocalMigrationSource(),
			getSessionId: () => sessionManager.getSessionId(),
		};
	}

	async resolve(url: InternalUrl): Promise<InternalResource> {
		const opts = LocalProtocolHandler.resolveOptions();
		if (!opts) {
			throw new Error("No session - local:// unavailable");
		}

		const resolvedRoot = await initializeLocalRoot(opts);

		const relativePath = extractRelativePath(url);
		const targetPath = relativePath ? path.resolve(resolvedRoot, relativePath) : resolvedRoot;
		ensureWithinRoot(targetPath, resolvedRoot);

		if (targetPath === resolvedRoot) {
			return buildListing(url, resolvedRoot);
		}

		const parentDir = path.dirname(targetPath);
		try {
			const realParent = await fs.realpath(parentDir);
			ensureWithinRoot(realParent, resolvedRoot);
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}

		let realTargetPath: string;
		try {
			realTargetPath = await fs.realpath(targetPath);
		} catch (error) {
			if (isEnoent(error)) {
				throw new Error(`Local file not found: ${url.href}`);
			}
			throw error;
		}

		ensureWithinRoot(realTargetPath, resolvedRoot);

		const stat = await fs.stat(realTargetPath);
		if (!stat.isFile()) {
			throw new Error(`local:// URL must resolve to a file: ${url.href}`);
		}

		const content = await Bun.file(realTargetPath).text();
		return {
			url: url.href,
			content,
			contentType: getContentType(realTargetPath),
			size: Buffer.byteLength(content, "utf-8"),
			sourcePath: realTargetPath,
			notes: ["Use write path local://<file> to persist large intermediate artifacts across turns."],
		};
	}
}
