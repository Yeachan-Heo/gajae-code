import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { gunzipSync } from "node:zlib";
import { compileGjcPluginBundle } from "./compiler";
import { gjcPluginProjectRoot, gjcPluginUserRoot } from "./paths";
import {
	readRegistry,
	registryEntryFingerprint,
	sortRegistryEntries,
	withRegistryLock,
	writeRegistryUnlocked,
} from "./registry";
import {
	GJC_PLUGIN_MANIFEST_FILENAME,
	GjcPluginLoadError,
	type GjcPluginRegistryEntry,
	type GjcPluginRegistrySource,
	type GjcPluginScope,
	type NormalizedGjcPluginBundle,
} from "./types";
import { validateInstallPlan } from "./validation";

export interface InstallGjcPluginOptions {
	scope: GjcPluginScope;
	cwd: string;
	force?: boolean;
}

export interface InstallGjcPluginResult {
	status: "installed" | "updated" | "unchanged";
	entry: GjcPluginRegistryEntry;
}

// Resource limits for the in-house tar extractor (third-party security boundary).
const TAR_MAX_FILES = 8192;
const TAR_MAX_FILE_BYTES = 16 * 1024 * 1024;
const TAR_MAX_TOTAL_BYTES = 128 * 1024 * 1024;

function scopeRoot(scope: GjcPluginScope, cwd: string): string {
	return scope === "user" ? gjcPluginUserRoot() : gjcPluginProjectRoot(cwd);
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
		throw new GjcPluginLoadError("missing_file", `GJC plugin source directory not found: ${source}`);
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
	const raw = await fs.readFile(tarPath);
	const buf = /\.(tgz|tar\.gz)$/i.test(tarPath) ? gunzipSync(raw) : raw;
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
	return new Promise((resolve, reject) => {
		// argv array (no shell) — repo/ref are passed as discrete args, not interpolated.
		const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", d => {
			stdout += d;
		});
		child.stderr.on("data", d => {
			stderr += d;
		});
		child.on("error", reject);
		child.on("close", code => {
			if (code === 0) resolve(stdout.trim());
			else reject(new GjcPluginLoadError("install_conflict", `git ${args[0]} failed: ${stderr.trim()}`));
		});
	});
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
	if (isTarball(source)) return resolveTarball(source);
	if (looksLikeGit(source)) return resolveGit(source);
	return resolveLocalPath(source);
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

export async function installGjcPluginBundle(
	source: string,
	options: InstallGjcPluginOptions,
): Promise<InstallGjcPluginResult> {
	const resolved = await resolveSource(source);
	try {
		// 1. Compile + validate (never imports plugin code).
		const bundle = await compileGjcPluginBundle(resolved.dir);
		const dirName = safeDirSegment(bundle.name);
		const root = scopeRoot(options.scope, options.cwd);
		const finalDir = path.join(root, dirName);

		// 2-4. Conflict check, atomic swap, and registry write are one serialized
		// transaction per scope so concurrent installs cannot race or lose updates.
		return await withRegistryLock(options.scope, options.cwd, async () => {
			await fs.mkdir(root, { recursive: true });
			await cleanupOrphans(root, dirName);

			const registry = await readRegistry(options.scope, options.cwd);
			const existing = registry.plugins.find(p => p.name === bundle.name);
			// Hard install-time collision + MCP security validation against the
			// effective installed registry (registry is the collision authority).
			validateInstallPlan(bundle, registry.plugins);
			const candidate = bundleToRegistryEntry(
				bundle,
				finalDir,
				options.scope,
				resolved.source,
				new Date().toISOString(),
			);
			if (existing) {
				const sameContent = registryEntryFingerprint(existing) === registryEntryFingerprint(candidate);
				if (sameContent && (await isDirectory(finalDir))) {
					return { status: "unchanged" as const, entry: existing };
				}
				if (!options.force) {
					throw new GjcPluginLoadError(
						"install_conflict",
						`GJC plugin "${bundle.name}" is already installed with different content; pass --force to replace it`,
					);
				}
			}

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
						...registry.plugins.filter(p => p.name !== bundle.name),
						{ ...candidate, installedAt: existing?.installedAt ?? candidate.installedAt },
					]);
					await writeRegistryUnlocked({ version: 1, scope: options.scope, plugins: next }, options.cwd);
				} catch (error) {
					await fs.rm(finalDir, { recursive: true, force: true });
					if (hadFinal) await fs.rename(backupDir, finalDir);
					throw error;
				}
				if (hadFinal) await fs.rm(backupDir, { recursive: true, force: true });
				return { status: existing ? ("updated" as const) : ("installed" as const), entry: candidate };
			} finally {
				await fs.rm(stagingDir, { recursive: true, force: true });
			}
		});
	} finally {
		await resolved.cleanup();
	}
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
