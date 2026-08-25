import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { gunzipSync } from "node:zlib";
import { compileGjcPluginBundle } from "./compiler";
import { gjcPluginProjectRoot, gjcPluginUserRoot } from "./paths";
import { readRegistry, sortRegistryEntries, withRegistryLock, writeRegistryUnlocked } from "./registry";
import {
	GJC_PLUGIN_MANIFEST_FILENAME,
	type GjcLifecycleError,
	GjcPluginLoadError,
	type GjcPluginRegistry,
	type GjcPluginRegistryEntry,
	type GjcPluginRegistrySource,
	type GjcPluginScope,
	type NormalizedGjcPluginBundle,
} from "./types";
import { validateInstallPlan } from "./validation";

export interface GjcBundleTransactionOptions {
	scope: GjcPluginScope;
	cwd: string;
	agentDir?: string;
	/**
	 * Policy hook evaluated while both scope locks are held. It decides whether
	 * to commit the candidate, report an already-satisfied no-op, or abort with
	 * a typed lifecycle error. Only the lifecycle service supplies this.
	 */
	decide: (input: GjcBundleTransactionContext) => Promise<GjcBundleTransactionDecision>;
}

export interface GjcBundleTransactionContext {
	targetRegistry: GjcPluginRegistry;
	/** Both scopes, deterministically sorted, for cross-scope decisions. */
	effective: GjcPluginRegistryEntry[];
	existing: GjcPluginRegistryEntry | undefined;
	bundle: NormalizedGjcPluginBundle;
	/** Entry the candidate would produce if committed as-is. */
	candidate: GjcPluginRegistryEntry;
}

export type GjcBundleTransactionDecision =
	| { kind: "commit"; entry: GjcPluginRegistryEntry }
	| { kind: "noop"; entry: GjcPluginRegistryEntry }
	| { kind: "abort"; error: GjcLifecycleError };

export type GjcBundleTransactionResult =
	| { status: "committed"; entry: GjcPluginRegistryEntry; remnants: string[] }
	| { status: "noop"; entry: GjcPluginRegistryEntry; remnants: string[] }
	| { status: "aborted"; error: GjcLifecycleError; remnants: string[] };

// Resource limits for the in-house tar extractor (third-party security boundary).
const TAR_MAX_FILES = 8192;
const TAR_MAX_FILE_BYTES = 16 * 1024 * 1024;
const TAR_MAX_TOTAL_BYTES = 128 * 1024 * 1024;
// Preserve the existing aggregate file budget plus the maximum per-entry
// header/padding overhead and the two terminating TAR blocks.
const TAR_MAX_ARCHIVE_BYTES = TAR_MAX_TOTAL_BYTES + TAR_MAX_FILES * 1024 + 1024;
// A gzip stream can be slightly larger than its incompressible TAR payload.
const TAR_MAX_COMPRESSED_BYTES = TAR_MAX_ARCHIVE_BYTES + 1024 * 1024;

function scopeRoot(scope: GjcPluginScope, cwd: string, agentDir?: string): string {
	return scope === "user" ? gjcPluginUserRoot(agentDir) : gjcPluginProjectRoot(cwd);
}

function safeDirSegment(name: string): string {
	const seg = name.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^-+|-+$/g, "");
	if (!seg || seg === "." || seg === "..") {
		throw new GjcPluginLoadError("invalid_manifest", `GJC plugin name is not a safe directory segment: ${name}`);
	}
	return seg;
}

async function isDirectory(p: string): Promise<boolean> {
	try {
		return (await fs.stat(p)).isDirectory();
	} catch {
		return false;
	}
}

async function fileExists(p: string): Promise<boolean> {
	try {
		await fs.access(p);
		return true;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Source resolution
// ---------------------------------------------------------------------------
export class GjcPluginSourceUnavailableError extends Error {
	readonly code = "source_unavailable" as const;
	constructor() {
		super("GJC plugin source is unavailable");
		this.name = "GjcPluginSourceUnavailableError";
	}
}

async function readTarballInput(tarPath: string, maxBytes: number): Promise<Buffer> {
	let file: fs.FileHandle;
	try {
		file = await fs.open(tarPath, "r");
	} catch {
		throw new GjcPluginSourceUnavailableError();
	}
	try {
		const stat = await file.stat();
		if (!stat.isFile()) throw new GjcPluginSourceUnavailableError();
		if (stat.size > maxBytes) {
			throw new GjcPluginLoadError("security_policy", "GJC plugin tarball exceeds the archive input limit");
		}
		const raw = Buffer.allocUnsafe(stat.size);
		let offset = 0;
		while (offset < raw.byteLength) {
			const { bytesRead } = await file.read(raw, offset, raw.byteLength - offset, offset);
			if (bytesRead === 0) {
				throw new GjcPluginLoadError("security_policy", "GJC plugin tarball changed while being read");
			}
			offset += bytesRead;
		}
		const probe = Buffer.allocUnsafe(1);
		if ((await file.read(probe, 0, 1, offset)).bytesRead !== 0) {
			throw new GjcPluginLoadError("security_policy", "GJC plugin tarball changed while being read");
		}
		return raw;
	} catch (error) {
		if (error instanceof GjcPluginLoadError || error instanceof GjcPluginSourceUnavailableError) throw error;
		throw new GjcPluginSourceUnavailableError();
	} finally {
		await file.close().catch(() => {});
	}
}

function isGunzipOutputLimitError(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ERR_BUFFER_TOO_LARGE";
}

interface ResolvedSource {
	dir: string;
	source: GjcPluginRegistrySource;
	cleanup: () => Promise<void>;
}

function isTarball(source: string): boolean {
	return /\.(tgz|tar\.gz|tar)$/i.test(source);
}

function looksLikeGit(source: string): boolean {
	return /^(https?|ssh|git):\/\//i.test(source) || /^git@/.test(source) || source.startsWith("git:");
}

async function resolveLocalPath(source: string): Promise<ResolvedSource> {
	const abs = path.resolve(source);
	if (!(await isDirectory(abs))) {
		throw new GjcPluginSourceUnavailableError();
	}
	return {
		dir: abs,
		source: { kind: "path", uri: abs, resolvedAt: new Date().toISOString() },
		cleanup: async () => {},
	};
}

function tarHeaderChecksumOk(header: Uint8Array): boolean {
	const stored = Number.parseInt(new TextDecoder().decode(header.subarray(148, 156)).replace(/\0.*$/, "").trim(), 8);
	if (!Number.isFinite(stored)) return false;
	let unsigned = 0;
	let signed = 0;
	for (let i = 0; i < 512; i++) {
		const byte = i >= 148 && i < 156 ? 0x20 : (header[i] ?? 0);
		unsigned += byte;
		signed += byte < 128 ? byte : byte - 256;
	}
	return stored === unsigned || stored === signed;
}

/** Minimal, traversal/symlink-safe, resource-bounded extraction of a tar(.gz). */
async function extractTarball(tarPath: string, destRoot: string): Promise<void> {
	const isGzip = /\.(tgz|tar\.gz)$/i.test(tarPath);
	const raw = await readTarballInput(tarPath, isGzip ? TAR_MAX_COMPRESSED_BYTES : TAR_MAX_ARCHIVE_BYTES);
	let buf: Buffer;
	try {
		buf = isGzip ? gunzipSync(raw, { maxOutputLength: TAR_MAX_ARCHIVE_BYTES }) : raw;
	} catch (error) {
		if (isGunzipOutputLimitError(error)) {
			throw new GjcPluginLoadError("security_policy", "GJC plugin tarball exceeds the expansion limit");
		}
		throw new GjcPluginLoadError("invalid_manifest", "GJC plugin tarball could not be decompressed");
	}
	const resolvedRoot = path.resolve(destRoot);
	const decoder = new TextDecoder();
	let offset = 0;
	let fileCount = 0;
	let totalBytes = 0;
	while (offset + 512 <= buf.byteLength) {
		const header = buf.subarray(offset, offset + 512);
		offset += 512;
		if (header.every(b => b === 0)) break; // end-of-archive marker
		if (!tarHeaderChecksumOk(header)) {
			throw new GjcPluginLoadError("security_policy", "Corrupt tar header checksum");
		}
		const name = decoder.decode(header.subarray(0, 100)).replace(/\0.*$/, "");
		const sizeField = decoder.decode(header.subarray(124, 136)).replace(/\0.*$/, "").trim();
		if (!/^[0-7]*$/.test(sizeField)) {
			throw new GjcPluginLoadError("security_policy", `Unsupported tar size encoding for ${name}`);
		}
		const size = sizeField ? Number.parseInt(sizeField, 8) : 0;
		if (!Number.isSafeInteger(size) || size < 0 || size > TAR_MAX_FILE_BYTES) {
			throw new GjcPluginLoadError("security_policy", `Tar entry size out of bounds for ${name}`);
		}
		const typeFlag = String.fromCharCode(header[156] ?? 0);
		const dataStart = offset;
		if (dataStart + size > buf.byteLength) {
			throw new GjcPluginLoadError("security_policy", `Truncated tar entry for ${name}`);
		}
		offset += Math.ceil(size / 512) * 512;
		// Skip metadata-only entries.
		if (typeFlag === "x" || typeFlag === "g") continue;
		const normalized = name.replace(/^\.\//, "");
		if (!normalized || normalized === "." || normalized === "pax_global_header") continue;
		if (normalized.startsWith("PaxHeader/") || normalized.includes("/PaxHeader/")) continue;
		if (path.basename(normalized).startsWith("._")) continue; // AppleDouble sidecar
		// Fail closed: only regular files and directories are allowed.
		const isDir = typeFlag === "5" || normalized.endsWith("/");
		const isFile = typeFlag === "0" || typeFlag === "\0" || typeFlag === "";
		if (!isDir && !isFile) {
			throw new GjcPluginLoadError("security_policy", `Unsafe tar entry type "${typeFlag}" for ${name}`);
		}
		if (path.isAbsolute(normalized)) {
			throw new GjcPluginLoadError("security_policy", `Absolute path in tar entry: ${name}`);
		}
		const dest = path.resolve(resolvedRoot, normalized);
		const rel = path.relative(resolvedRoot, dest);
		if (rel.startsWith("..") || path.isAbsolute(rel)) {
			throw new GjcPluginLoadError("security_policy", `Tar entry escapes destination: ${name}`);
		}
		if (isDir) {
			await fs.mkdir(dest, { recursive: true });
			continue;
		}
		fileCount += 1;
		totalBytes += size;
		if (fileCount > TAR_MAX_FILES || totalBytes > TAR_MAX_TOTAL_BYTES) {
			throw new GjcPluginLoadError("security_policy", "Tar archive exceeds extraction limits");
		}
		await fs.mkdir(path.dirname(dest), { recursive: true });
		await fs.writeFile(dest, buf.subarray(dataStart, dataStart + size));
	}
}

async function findManifestRoot(base: string): Promise<string | null> {
	if (await fileExists(path.join(base, GJC_PLUGIN_MANIFEST_FILENAME))) return base;
	let entries: import("node:fs").Dirent[];
	try {
		entries = await fs.readdir(base, { withFileTypes: true });
	} catch {
		return null;
	}
	for (const dir of entries.filter(e => e.isDirectory())) {
		const candidate = path.join(base, dir.name);
		if (await fileExists(path.join(candidate, GJC_PLUGIN_MANIFEST_FILENAME))) return candidate;
	}
	return null;
}

async function resolveTarball(source: string): Promise<ResolvedSource> {
	const temp = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-plugin-tar-"));
	try {
		await extractTarball(source, temp);
		const dir = await findManifestRoot(temp);
		if (!dir) throw new GjcPluginLoadError("missing_file", `No ${GJC_PLUGIN_MANIFEST_FILENAME} found in tarball`);
		return {
			dir,
			source: { kind: "tarball", uri: path.resolve(source), resolvedAt: new Date().toISOString() },
			cleanup: async () => {
				await fs.rm(temp, { recursive: true, force: true });
			},
		};
	} catch (error) {
		await fs.rm(temp, { recursive: true, force: true });
		throw error;
	}
}

function runGit(args: string[], cwd?: string): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	// argv array (no shell) — repo/ref are passed as discrete args, not interpolated.
	const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "";
	child.stdout.on("data", d => {
		stdout += d;
	});
	// stderr is drained but never surfaced: git writes the remote URL into it,
	// which can carry credentials.
	child.stderr.resume();
	// A spawn failure (git missing, ENOENT, EACCES) arrives as a raw system
	// error. Convert it so the lifecycle can report a typed, sanitized source
	// failure instead of letting an errno escape to the CLI.
	child.on("error", () => {
		reject(new GjcPluginSourceUnavailableError());
	});
	child.on("close", code => {
		if (code === 0) resolve(stdout.trim());
		// A failed clone/ref resolution is a source-access failure. A successful
		// clone that lacks a manifest is classified later as invalid_target.
		else reject(new GjcPluginSourceUnavailableError());
	});
	return promise;
}

async function resolveGit(source: string): Promise<ResolvedSource> {
	const hashIndex = source.indexOf("#");
	const repo = hashIndex >= 0 ? source.slice(0, hashIndex) : source;
	const ref = hashIndex >= 0 ? source.slice(hashIndex + 1) : undefined;
	const temp = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-plugin-git-"));
	try {
		const cloneArgs = ["clone", "--depth", "1"];
		if (ref) cloneArgs.push("--branch", ref);
		cloneArgs.push("--", repo, temp);
		await runGit(cloneArgs);
		let sha: string | undefined;
		try {
			sha = await runGit(["rev-parse", "HEAD"], temp);
		} catch {
			sha = undefined;
		}
		const dir = await findManifestRoot(temp);
		if (!dir) throw new GjcPluginLoadError("missing_file", `No ${GJC_PLUGIN_MANIFEST_FILENAME} found in git source`);
		return {
			dir,
			source: { kind: "git", uri: repo, ref, sha, resolvedAt: new Date().toISOString() },
			cleanup: async () => {
				await fs.rm(temp, { recursive: true, force: true });
			},
		};
	} catch (error) {
		await fs.rm(temp, { recursive: true, force: true });
		throw error;
	}
}

async function resolveSource(source: string): Promise<ResolvedSource> {
	try {
		if (isTarball(source)) return await resolveTarball(source);
		if (looksLikeGit(source)) return await resolveGit(source);
		return await resolveLocalPath(source);
	} catch (error) {
		if (error instanceof GjcPluginSourceUnavailableError || error instanceof GjcPluginLoadError) throw error;
		throw new GjcPluginSourceUnavailableError();
	}
}

// ---------------------------------------------------------------------------
// Copy + publish
// ---------------------------------------------------------------------------

function bundleToRegistryEntry(
	bundle: NormalizedGjcPluginBundle,
	pluginRoot: string,
	scope: GjcPluginScope,
	source: GjcPluginRegistrySource,
	now: string,
): GjcPluginRegistryEntry {
	return {
		name: bundle.name,
		version: bundle.version,
		scope,
		enabled: true,
		pluginRoot,
		manifestPath: path.join(pluginRoot, GJC_PLUGIN_MANIFEST_FILENAME),
		manifestHash: bundle.manifestHash,
		source,
		installedAt: now,
		updatedAt: now,
		copiedFiles: bundle.files,
		surfaces: bundle.surfaces,
		disabledSurfaceIds: [],
	};
}

function sha256(buf: Buffer): string {
	return createHash("sha256").update(buf).digest("hex");
}

/**
 * Copy ONLY the validated, hashed files (bundle.files) from the source into the
 * staging dir, re-verifying each hash. Undeclared files and symlinks are never
 * copied, so the installed tree equals the validated set.
 */
async function copyValidatedFiles(bundle: NormalizedGjcPluginBundle, stagingDir: string): Promise<void> {
	for (const file of bundle.files) {
		const src = path.join(bundle.root, file.relativePath);
		const lst = await fs.lstat(src);
		if (lst.isSymbolicLink()) {
			throw new GjcPluginLoadError("security_policy", `Refusing to copy symlink: ${file.relativePath}`);
		}
		const buf = await fs.readFile(src);
		if (sha256(buf) !== file.sha256) {
			throw new GjcPluginLoadError("hash_mismatch", `Source changed during install: ${file.relativePath}`);
		}
		const dest = path.join(stagingDir, file.relativePath);
		await fs.mkdir(path.dirname(dest), { recursive: true });
		await fs.writeFile(dest, buf);
	}
}

async function cleanupOrphans(root: string, dirName: string): Promise<void> {
	try {
		const entries = await fs.readdir(root);
		await Promise.all(
			entries
				.filter(e => e.startsWith(`${dirName}.installing-`) || e.startsWith(`${dirName}.backup-`))
				.map(e => fs.rm(path.join(root, e), { recursive: true, force: true })),
		);
	} catch {
		// best-effort
	}
}

/**
 * Serialized bundle transaction: prepare outside the locks, then hold the
 * user->project locks in a fixed order so the decision sees a consistent
 * cross-scope view. Only the target scope is ever committed.
 */
export async function runGjcBundleTransaction(
	source: string,
	options: GjcBundleTransactionOptions,
): Promise<GjcBundleTransactionResult> {
	const resolved = await resolveSource(source);
	try {
		// Compile + validate candidate-internal collisions and MCP policy outside
		// every lock (never imports plugin code). Registry collisions are rechecked
		// under both locks below, but a statically invalid candidate must not create
		// lock roots or sweep installation remnants.
		const bundle = await compileGjcPluginBundle(resolved.dir);
		validateInstallPlan(bundle, []);
		const dirName = safeDirSegment(bundle.name);
		const root = scopeRoot(options.scope, options.cwd, options.agentDir);
		const finalDir = path.join(root, dirName);

		// Lock-free refusal preflight. Acquiring a scope lock creates the scope
		// root and mutates directory metadata, so a create-only refusal must be
		// decided before any lock is taken; otherwise "zero mutation" is false.
		// The locked decision below re-checks, so this is an early-out only.
		const preflightTarget = await readRegistry(options.scope, options.cwd, {
			migrate: false,
			agentDir: options.agentDir,
		});
		const preexisting = preflightTarget.plugins.find(p => p.name === bundle.name);
		if (preexisting) {
			// The decision may compare a cross-scope fingerprint, so it must see the
			// same complete universe the locked decision sees.
			const preflightOther = await readRegistry(options.scope === "user" ? "project" : "user", options.cwd, {
				migrate: false,
				agentDir: options.agentDir,
			});
			const early = await options.decide({
				targetRegistry: preflightTarget,
				effective: sortRegistryEntries([...preflightTarget.plugins, ...preflightOther.plugins]),
				existing: preexisting,
				bundle,
				candidate: bundleToRegistryEntry(
					bundle,
					finalDir,
					options.scope,
					resolved.source,
					new Date().toISOString(),
				),
			});
			// Only an abort is honoured here; everything else is re-decided under
			// the lock, so this can never short-circuit a commit.
			if (early.kind === "abort") return { status: "aborted", error: early.error, remnants: [] };
		}

		const critical = async (): Promise<GjcBundleTransactionResult> => {
			// Read-only until the policy decision resolves. A refusal must not create
			// the scope root or sweep orphans, so an existing-target refusal leaves
			// the filesystem byte-for-byte untouched.

			const targetRegistry = await readRegistry(options.scope, options.cwd, {
				migrate: false,
				agentDir: options.agentDir,
			});
			const otherScope: GjcPluginScope = options.scope === "user" ? "project" : "user";
			const otherRegistry = await readRegistry(otherScope, options.cwd, {
				migrate: false,
				agentDir: options.agentDir,
			});
			const effective = sortRegistryEntries([...targetRegistry.plugins, ...otherRegistry.plugins]);
			const existing = targetRegistry.plugins.find(p => p.name === bundle.name);
			const candidate = bundleToRegistryEntry(
				bundle,
				finalDir,
				options.scope,
				resolved.source,
				new Date().toISOString(),
			);

			const decision = await options.decide({ targetRegistry, effective, existing, bundle, candidate });
			if (decision.kind === "abort") return { status: "aborted", error: decision.error, remnants: [] };
			if (decision.kind === "noop") return { status: "noop", entry: decision.entry, remnants: [] };

			// Hard install-time collision + MCP security validation against the
			// effective registry across BOTH scopes. Surface IDs derive from the
			// surface name, not the bundle name, so a differently named bundle in
			// the opposite scope can claim the same ID; only the exact target
			// identity is excluded, since that is the entry being replaced.
			validateInstallPlan(bundle, effective);

			// The decision and all validation committed, so mutation may begin.
			await fs.mkdir(root, { recursive: true });
			await cleanupOrphans(root, dirName);

			const unique = `${process.pid}-${randomBytes(6).toString("hex")}`;
			const stagingDir = `${finalDir}.installing-${unique}`;
			const backupDir = `${finalDir}.backup-${unique}`;
			await fs.rm(stagingDir, { recursive: true, force: true });
			try {
				await copyValidatedFiles(bundle, stagingDir);
				const hadFinal = await isDirectory(finalDir);
				if (hadFinal) await fs.rename(finalDir, backupDir);
				try {
					await fs.rename(stagingDir, finalDir);
				} catch (error) {
					if (hadFinal) await fs.rename(backupDir, finalDir);
					throw error;
				}
				// Registry write last; on failure, roll the filesystem back.
				try {
					const next = sortRegistryEntries([
						...targetRegistry.plugins.filter(p => p.name !== bundle.name),
						decision.entry,
					]);
					await writeRegistryUnlocked(
						{ version: 1, scope: options.scope, plugins: next },
						options.cwd,
						options.scope,
						options.agentDir,
					);
				} catch (error) {
					await fs.rm(finalDir, { recursive: true, force: true });
					if (hadFinal) await fs.rename(backupDir, finalDir);
					throw error;
				}
				const remnants: string[] = [];
				if (hadFinal) {
					try {
						await fs.rm(backupDir, { recursive: true, force: true });
					} catch {
						remnants.push(backupDir);
					}
				}
				return { status: "committed", entry: decision.entry, remnants };
			} finally {
				await fs.rm(stagingDir, { recursive: true, force: true });
			}
		};

		// Surface IDs are globally unique, so the collision decision spans both
		// scopes and must be serialized against every other writer. Both locks are
		// therefore held, in a fixed user->project order to avoid deadlock,
		// regardless of which scope commits. Refusal purity is preserved by the
		// pre-lock preflight above, which returns before any lock is acquired.
		return await withRegistryLock(
			"user",
			options.cwd,
			() => withRegistryLock("project", options.cwd, critical, options.agentDir),
			options.agentDir,
		);
	} finally {
		await resolved.cleanup();
	}
}

/** Compile a source into a validated candidate bundle without touching disk state. */
export async function resolveGjcBundleCandidate<T>(
	source: string,
	fn: (input: { bundle: NormalizedGjcPluginBundle; source: GjcPluginRegistrySource }) => Promise<T>,
): Promise<T> {
	const resolved = await resolveSource(source);
	try {
		const bundle = await compileGjcPluginBundle(resolved.dir);
		return await fn({ bundle, source: resolved.source });
	} finally {
		await resolved.cleanup();
	}
}

/** Build the registry entry a candidate bundle would produce at a target path. */
export function candidateRegistryEntry(
	bundle: NormalizedGjcPluginBundle,
	scope: GjcPluginScope,
	cwd: string,
	source: GjcPluginRegistrySource,
	now: string,
	agentDir?: string,
): GjcPluginRegistryEntry {
	const finalDir = path.join(scopeRoot(scope, cwd, agentDir), safeDirSegment(bundle.name));
	return bundleToRegistryEntry(bundle, finalDir, scope, source, now);
}

/**
 * True when a spec has the SHAPE of a GJC bundle source: a filesystem path, a
 * git locator, or a tarball. This is a pure string test that never touches the
 * filesystem or the network, so a deleted or unreachable source is still
 * recognised as GJC-intent and can reach the lifecycle's typed refusal instead
 * of falling through to npm.
 *
 * npm and marketplace specs are never path/git/tarball shaped, so this cleanly
 * separates the two install worlds.
 */
export function isGjcPluginSourceShape(source: string): boolean {
	if (looksLikeGit(source)) return true;
	// Explicit path forms, POSIX and Windows.
	const isPathShaped =
		source.startsWith("/") ||
		source.startsWith("./") ||
		source.startsWith("../") ||
		source.startsWith("~/") ||
		source.startsWith(".\\") ||
		source.startsWith("..\\") ||
		/^[a-zA-Z]:[\\/]/.test(source) ||
		source.startsWith("\\\\");
	if (isPathShaped) return true;
	// A tarball SUFFIX alone is not enough: npm package names may contain dots,
	// so `foo.tgz` and `@scope/foo.tar.gz` are legal npm specs. Only claim an
	// archive when the locator is also path- or URL-shaped.
	return isTarball(source) && /^[a-z][a-z0-9+.-]*:\/\//i.test(source);
}

/** True only when the source actually resolves to a GJC plugin bundle (root gajae-plugin.json). */
export async function isGjcPluginBundleSource(source: string): Promise<boolean> {
	if (!isTarball(source) && !looksLikeGit(source)) {
		const abs = path.resolve(source);
		return await fileExists(path.join(abs, GJC_PLUGIN_MANIFEST_FILENAME));
	}
	// Probe git/tarball content safely, then clean up; never throw for non-bundles.
	try {
		const resolved = await resolveSource(source);
		try {
			return await fileExists(path.join(resolved.dir, GJC_PLUGIN_MANIFEST_FILENAME));
		} finally {
			await resolved.cleanup();
		}
	} catch {
		return false;
	}
}
