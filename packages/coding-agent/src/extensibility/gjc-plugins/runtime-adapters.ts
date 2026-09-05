import { createHash, randomBytes } from "node:crypto";
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { bindPluginMcpToPublicNetwork } from "../../runtime-mcp/plugin-network-boundary";
import type { MCPStdioPreparedLaunch, MCPStdioSpawnLaunch } from "../../runtime-mcp/types";
import { loadCustomTools } from "../custom-tools/loader";
import type { CustomTool } from "../custom-tools/types";
import { compileGjcPluginBundle } from "./compiler";
import { bundleIdentity } from "./lifecycle-reconciliation";
import {
	assertDnsResolvesPublic,
	assertMcpInstallPolicy,
	assertUrlAllowed,
	classifyStdioInvocation,
} from "./mcp-policy";
import { canonicalJson, verifyImplementationHash } from "./metadata";
import { isV2Tool } from "./migration";
import { gjcPluginInstallRoot, resolveWithinRoot } from "./paths";
import { loadEffectiveGjcPluginRegistry, registryPathForScope, registryRootForScope } from "./registry";
import { type SessionQuarantine, type SessionValidationResult, validateSessionBundles } from "./session-validation";
import type { GjcPluginRegistryEntry, GjcPluginScope, JsonSchema202012, NormalizedToolSurfaceV2 } from "./types";

export interface AlwaysOnPluginTools {
	tools: CustomTool[];
	quarantine: SessionQuarantine[];
}

export interface GjcPluginToolDeclaration extends NormalizedToolSurfaceV2 {
	plugin: string;
	scope: GjcPluginScope;
}

function isWithin(root: string, target: string): boolean {
	const rel = path.relative(root, target);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

async function resolveRuntimeFile(root: string, relativePath: string): Promise<string> {
	const lexical = resolveWithinRoot(root, relativePath);
	const [rootReal, fileReal] = await Promise.all([fs.realpath(root), fs.realpath(lexical)]);
	if (!isWithin(rootReal, fileReal))
		throw new Error(`GJC plugin implementation escapes its installed root: ${relativePath}`);
	return fileReal;
}
/**
 * Return v2 tool declarations without reading or importing implementation
 * modules. This is the schema-serving path used by discovery and diagnostics.
 */
export async function getGjcPluginToolDeclarations(cwd: string): Promise<GjcPluginToolDeclaration[]> {
	const entries = await loadEffectiveGjcPluginRegistry(cwd);
	const declarations: GjcPluginToolDeclaration[] = [];
	for (const entry of entries) {
		if (!entry.enabled || entry.migration?.status === "failed") continue;
		for (const surface of entry.surfaces.tools) {
			if (isV2Tool(surface))
				declarations.push({ ...surface, plugin: entry.name, scope: entry.scope } as GjcPluginToolDeclaration);
		}
	}
	return declarations;
}

/** Serve the canonical schemas keyed by their stable tool surface id. */
export async function serveGjcPluginSchemas(cwd: string): Promise<Record<string, JsonSchema202012>> {
	const declarations = await getGjcPluginToolDeclarations(cwd);
	return Object.fromEntries(declarations.map(declaration => [declaration.extensionId, declaration.schema]));
}

interface FileSnapshot {
	path: string;
	mtimeMs: number;
	ctimeMs: number;
	size: number;
	ino: number;
}

interface ValidatedPluginRegistry {
	effective: GjcPluginRegistryEntry[];
	active: GjcPluginRegistryEntry[];
	quarantine: SessionQuarantine[];
	validation: SessionValidationResult;
	registryFiles: FileSnapshot[];
	pluginFiles: FileSnapshot[];
}

interface CachedValidatedPluginRegistry extends ValidatedPluginRegistry {
	registryKey: string;
	pluginKey: string;
}

const validatedRegistryCache = new Map<string, CachedValidatedPluginRegistry>();
const hashCache = new Map<string, string>();
// Bound the digest memo so long sessions with plugin churn cannot grow it
// unboundedly; entries are re-derivable from disk at the cost of one read.
const HASH_CACHE_MAX_ENTRIES = 512;
const MCP_SNAPSHOT_MAX_FILES = 8_192;
const MCP_SNAPSHOT_MAX_BYTES = 128 * 1024 * 1024;
const MCP_LAUNCHER_MAX_BYTES = 512 * 1024 * 1024;
const registryScopes: GjcPluginScope[] = ["user", "project"];
const initialProcessEnvironment =
	process.platform === "linux"
		? fs.readFile("/proc/self/environ").then(
				bytes =>
					new Map(
						bytes
							.toString("utf8")
							.split("\0")
							.flatMap(entry => {
								const separator = entry.indexOf("=");
								return separator > 0 ? [[entry.slice(0, separator), entry.slice(separator + 1)] as const] : [];
							}),
					),
				() => new Map<string, string>(),
			)
		: Promise.resolve(new Map<string, string>());
const initialTemporaryRoots = initialProcessEnvironment.then(async environment => {
	const candidates = [environment.get("TMPDIR"), environment.get("TEMP"), environment.get("TMP"), "/tmp", "/var/tmp"]
		.filter((root): root is string => typeof root === "string" && path.isAbsolute(root))
		.map(root => path.resolve(root));
	const roots = new Set<string>();
	for (const candidate of candidates) {
		roots.add(candidate);
		roots.add(await fs.realpath(candidate).catch(() => candidate));
	}
	return [...roots];
});
const initialNodeAuthorities = initialProcessEnvironment.then(async environment => {
	const authorities = new Map<string, string>();
	const temporaryRoots = await initialTemporaryRoots;
	for (const pathEntry of (environment.get("PATH") ?? "").split(path.delimiter).filter(path.isAbsolute)) {
		const lexical = path.join(pathEntry, process.platform === "win32" ? "node.exe" : "node");
		try {
			const real = await fs.realpath(lexical);
			if (temporaryRoots.some(root => isWithin(root, real))) continue;
			const bytes = await readStableFile(real, "Initial Node executable", MCP_LAUNCHER_MAX_BYTES, true);
			authorities.set(real, sha256(bytes));
		} catch {
			// Missing or unstable startup candidates do not become authority.
		}
	}
	return authorities;
});

async function snapshotExistingFile(filePath: string): Promise<FileSnapshot | null> {
	try {
		const stat = await fs.stat(filePath);
		return { path: filePath, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, size: stat.size, ino: stat.ino };
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
		throw error;
	}
}

function snapshotsKey(snapshots: readonly FileSnapshot[]): string {
	return snapshots.map(s => `${s.path}:${s.mtimeMs}:${s.ctimeMs}:${s.size}:${s.ino}`).join("|");
}

async function snapshotRegistryFiles(cwd: string): Promise<FileSnapshot[]> {
	const snapshots = await Promise.all(
		registryScopes.map(scope => snapshotExistingFile(registryPathForScope(scope, cwd))),
	);
	return snapshots.filter((s): s is FileSnapshot => s !== null);
}

async function snapshotPluginFiles(entries: readonly GjcPluginRegistryEntry[]): Promise<FileSnapshot[]> {
	const snapshots: FileSnapshot[] = [];
	for (const entry of entries) {
		if (!entry.enabled) continue;
		for (const file of entry.copiedFiles) {
			const abs = path.join(entry.pluginRoot, file.relativePath);
			const snapshot = await snapshotExistingFile(abs);
			if (!snapshot) {
				snapshots.push({ path: abs, mtimeMs: Number.NaN, ctimeMs: Number.NaN, size: Number.NaN, ino: Number.NaN });
			} else {
				snapshots.push(snapshot);
			}
		}
	}
	return snapshots;
}

function sha256(buf: Buffer): string {
	return createHash("sha256").update(buf).digest("hex");
}

function canonicalPersistedJson(value: unknown): string {
	const serialized = JSON.stringify(value);
	if (serialized === undefined) throw new Error("Cannot canonicalize an undefined persisted value");
	return canonicalJson(JSON.parse(serialized) as unknown);
}

const VERIFIED_STDIO_MODULE_WRAPPER = `
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, readdir } from "node:fs/promises";
import { register } from "node:module";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const [entrypointPath, snapshotRoot, authorityPath, expectedAuthorityHash, ...serverArgs] = process.argv.slice(1);
if (!entrypointPath || !snapshotRoot || !authorityPath || !/^[a-f0-9]{64}$/u.test(expectedAuthorityHash ?? "")) {
	throw new Error("invalid verified plugin MCP launch metadata");
}
if (process.versions.bun || process.release?.name !== "node") {
	throw new Error("Authenticated plugin MCP wrapper requires Node");
}
const flags = constants.O_RDONLY | (typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0);
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const isWithin = (root, target) => {
	const rel = relative(root, target);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};
const resolveInside = (root, relativePath, label) => {
	if (typeof relativePath !== "string" || relativePath.length === 0 || isAbsolute(relativePath)) {
		throw new Error(label + " is not a relative file path");
	}
	const target = resolve(root, relativePath);
	if (!isWithin(root, target) || target === root) throw new Error(label + " escapes its authenticated root");
	return target;
};
async function readStableFile(target, label, maxBytes) {
	const handle = await open(target, flags);
	try {
		const before = await handle.stat();
		if (!before.isFile()) throw new Error(label + " is not a regular file");
		if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || before.size > maxBytes) throw new Error(label + " exceeds its byte authority");
		const chunks = [];
		let offset = 0;
		for (;;) {
			const remaining = maxBytes + 1 - offset;
			if (remaining <= 0) throw new Error(label + " exceeds its byte authority");
			const chunk = Buffer.allocUnsafe(Math.min(1024 * 1024, remaining));
			const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, offset);
			if (bytesRead === 0) break;
			chunks.push(chunk.subarray(0, bytesRead));
			offset += bytesRead;
			if (offset > before.size) throw new Error(label + " grew while reading");
		}
		const bytes = Buffer.concat(chunks, offset);
		const after = await handle.stat();
		if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || bytes.byteLength !== after.size) {
			throw new Error(label + " changed while reading");
		}
		return bytes;
	} finally {
		await handle.close();
	}
}

const snapshotReal = await realpath(snapshotRoot);
if (snapshotReal !== snapshotRoot || !isWithin(snapshotRoot, entrypointPath) || !isWithin(snapshotRoot, process.cwd())) {
	throw new Error("verified plugin MCP snapshot authority drifted before execution");
}
const authorityBytes = await readStableFile(authorityPath, "plugin MCP snapshot authority", 2 * 1024 * 1024);
if (sha256(authorityBytes) !== expectedAuthorityHash) throw new Error("plugin MCP snapshot authority hash mismatch");
const authority = JSON.parse(authorityBytes.toString("utf8"));
if (!Array.isArray(authority.files) || authority.files.length === 0) throw new Error("plugin MCP snapshot files are missing");
const expectedPaths = new Set();
const authenticatedSources = new Map();
for (const file of authority.files) {
	if (!file || typeof file.relativePath !== "string" || !/^[a-f0-9]{64}$/u.test(file.sha256)) throw new Error("plugin MCP snapshot record is malformed");
	const target = resolveInside(snapshotRoot, file.relativePath, "plugin MCP snapshot file");
	if (expectedPaths.has(target)) throw new Error("plugin MCP snapshot path is duplicated");
	expectedPaths.add(target);
	const bytes = await readStableFile(target, "plugin MCP snapshot file", file.bytes);
	if (bytes.byteLength !== file.bytes || sha256(bytes) !== file.sha256) throw new Error("plugin MCP snapshot file hash mismatch");
	authenticatedSources.set(pathToFileURL(target).href, bytes);
}
async function verifyTree(directory) {
	for (const child of await readdir(directory, { withFileTypes: true })) {
		const target = resolve(directory, child.name);
		if (child.isDirectory()) await verifyTree(target);
		else if (!child.isFile() || !expectedPaths.delete(target)) throw new Error("plugin MCP snapshot contains unauthenticated content");
	}
}
await verifyTree(snapshotRoot);
if (expectedPaths.size !== 0) throw new Error("plugin MCP snapshot is incomplete");
const entrypointUrl = pathToFileURL(entrypointPath).href;
if (!authenticatedSources.has(entrypointUrl)) throw new Error("plugin MCP entrypoint is not authenticated");

if (typeof process.getBuiltinModule === "function") {
	const getBuiltinModule = process.getBuiltinModule.bind(process);
	process.getBuiltinModule = name => {
		if (name === "module" || name === "node:module") throw new Error("plugin MCP module loader access is not allowed");
		return getBuiltinModule(name);
	};
}
const loader = [
	'import { isAbsolute, relative } from "node:path";',
	'import { fileURLToPath } from "node:url";',
	'let root;',
	'let sources;',
	'export function initialize(data) {',
	'  root = data.snapshotRoot;',
	'  sources = new Map(data.authenticatedSources);',
	'  if (sources.size === 0) throw new Error("plugin MCP authenticated module bytes are missing");',
	'}',
	'const within = target => { const rel = relative(root, target); return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)); };',
	'const directFileUrl = (specifier, parentURL) => {',
	'  if (specifier.startsWith("file:")) return new URL(specifier).href;',
	'  if (!specifier.startsWith("./") && !specifier.startsWith("../") && !specifier.startsWith("/")) return undefined;',
	'  if (!parentURL?.startsWith("file:")) throw new Error("plugin MCP file import has no authenticated parent: " + specifier);',
	'  return new URL(specifier, parentURL).href;',
	'};',
	'const authenticatedFormat = format => {',
	'  if (format === "commonjs" || format === "commonjs-typescript" || format === "addon") throw new Error("plugin MCP CommonJS/native modules are not supported");',
	'  if (format !== "module" && format !== "module-typescript" && format !== "json" && format !== "wasm") throw new Error("plugin MCP module format is not supported: " + String(format));',
	'  return format;',
	'};',
	'export async function resolve(specifier, context, nextResolve) {',
	'  if (specifier === "module" || specifier === "node:module") throw new Error("plugin MCP module loader access is not allowed");',
	'  const expectedUrl = directFileUrl(specifier, context.parentURL);',
	'  const result = await nextResolve(specifier, context);',
	'  if (result.url === "node:module") throw new Error("plugin MCP module loader access is not allowed");',
	'  if (result.url.startsWith("node:")) return result;',
	'  if (!result.url.startsWith("file:") || !within(fileURLToPath(result.url))) throw new Error("plugin MCP import escapes its authenticated snapshot: " + specifier);',
	'  if (expectedUrl !== undefined && result.url !== expectedUrl) throw new Error("plugin MCP module identity drifted during resolution: " + specifier);',
	'  if (!sources.has(result.url)) throw new Error("plugin MCP import is not an authenticated snapshot module: " + specifier);',
	'  authenticatedFormat(result.format);',
	'  return result;',
	'}',
	'export async function load(url, context, nextLoad) {',
	'  if (url === "node:module") throw new Error("plugin MCP module loader access is not allowed");',
	'  if (url.startsWith("node:")) return nextLoad(url, context);',
	'  if (!url.startsWith("file:") || !within(fileURLToPath(url))) throw new Error("plugin MCP module load escapes its authenticated snapshot: " + url);',
	'  const source = sources.get(url);',
	'  if (source === undefined) throw new Error("plugin MCP module load is not authenticated: " + url);',
	'  return { format: authenticatedFormat(context.format), source: Uint8Array.from(source).buffer, shortCircuit: true };',
	'}',
].join("\\n");
register("data:text/javascript," + encodeURIComponent(loader), {
	parentURL: import.meta.url,
	data: { snapshotRoot, authenticatedSources: [...authenticatedSources] },
});
authenticatedSources.clear();

process.argv = [process.execPath, entrypointPath, ...serverArgs];
await import(entrypointUrl);
`;

async function readStableFile(
	filePath: string,
	label: string,
	maxBytes: number,
	followSymlink = false,
): Promise<Buffer> {
	const noFollow =
		followSymlink || filePath === "/proc/self/exe" || typeof fs.constants.O_NOFOLLOW !== "number"
			? 0
			: fs.constants.O_NOFOLLOW;
	const flags = fs.constants.O_RDONLY | noFollow;
	const handle = await fs.open(filePath, flags);
	try {
		const before = await handle.stat();
		if (!before.isFile()) throw new Error(`${label} is not a regular file`);
		if (before.size > maxBytes) throw new Error(`${label} exceeds its byte limit`);
		const chunks: Buffer[] = [];
		let offset = 0;
		for (;;) {
			const remaining = maxBytes + 1 - offset;
			if (remaining <= 0) throw new Error(`${label} exceeds its byte limit`);
			const chunk = Buffer.allocUnsafe(Math.min(1024 * 1024, remaining));
			const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, offset);
			if (bytesRead === 0) break;
			chunks.push(chunk.subarray(0, bytesRead));
			offset += bytesRead;
		}
		const bytes = Buffer.concat(chunks, offset);
		const after = await handle.stat();
		if (
			before.dev !== after.dev ||
			before.ino !== after.ino ||
			before.size !== after.size ||
			before.mtimeMs !== after.mtimeMs ||
			before.ctimeMs !== after.ctimeMs ||
			bytes.byteLength !== after.size
		) {
			throw new Error(`${label} changed while reading`);
		}
		return bytes;
	} finally {
		await handle.close();
	}
}

/**
 * Resolve host launchers through absolute PATH entries outside the workspace
 * and installed plugin. Relative entries such as `.` and absolute workspace
 * entries can otherwise select repository-controlled executables before the
 * authenticated plugin wrapper.
 */
async function resolveTrustedStdioLauncher(
	launcher: "node" | "bun",
	workspaceRoot: string,
	pluginRoot: string,
): Promise<string> {
	const lexicalRoots = [workspaceRoot, pluginRoot].map(root => path.resolve(root));
	const realRoots = await Promise.all(lexicalRoots.map(root => fs.realpath(root)));
	const untrustedRoots = [...new Set([...lexicalRoots, ...realRoots])];
	if (launcher === "bun") {
		const runningExecutable = process.platform === "linux" ? "/proc/self/exe" : process.execPath;
		const real = await fs.realpath(runningExecutable);
		if (untrustedRoots.some(root => isWithin(root, real))) {
			throw new Error("The running Bun executable overlaps an untrusted plugin/workspace root");
		}
		if (!(await fs.stat(real)).isFile()) throw new Error("The running Bun executable is not a regular file");
		return runningExecutable;
	}
	const pathEntries = (Bun.env.PATH ?? "")
		.split(path.delimiter)
		.map(entry => {
			const trimmed = entry.trim();
			return trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed;
		})
		.filter(entry => entry.length > 0 && path.isAbsolute(entry));

	for (const pathEntry of pathEntries) {
		const candidate = Bun.which(launcher, { PATH: pathEntry });
		if (!candidate || !path.isAbsolute(candidate)) continue;
		try {
			const lexicalCandidate = path.join(pathEntry, path.basename(candidate));
			if (!untrustedRoots.some(root => isWithin(root, lexicalCandidate))) {
				const realCandidate = await fs.realpath(lexicalCandidate);
				if (
					!untrustedRoots.some(root => isWithin(root, realCandidate)) &&
					(await isInitialManagedNodeLauncherPath(lexicalCandidate, untrustedRoots))
				) {
					return realCandidate;
				}
			}
			const lexical = path.resolve(candidate);
			if (untrustedRoots.some(root => isWithin(root, lexical))) continue;
			const real = await fs.realpath(lexical);
			if (untrustedRoots.some(root => isWithin(root, real))) continue;
			if (await isInitialManagedNodeLauncherPath(lexical, untrustedRoots)) return real;
		} catch {
			// A stale PATH entry is not launcher authority; try the next one.
		}
	}
	throw new Error(`Trusted stdio launcher is unavailable from absolute host PATH entries: ${launcher}`);
}

async function isInitialManagedNodeLauncherPath(
	executablePath: string,
	untrustedRoots: readonly string[],
): Promise<boolean> {
	if (process.platform !== "linux") return false;
	const real = await fs.realpath(executablePath);
	if (untrustedRoots.some(root => isWithin(root, real))) return false;
	if ((await initialTemporaryRoots).some(root => isWithin(root, real))) return false;
	const expected = (await initialNodeAuthorities).get(real);
	if (!expected) return false;
	const bytes = await readStableFile(real, "Initial Node executable", MCP_LAUNCHER_MAX_BYTES, true);
	return sha256(bytes) === expected;
}

async function resolveTrustedSnapshotBase(
	workspaceRoot: string,
	pluginRoot: string,
): Promise<{
	baseReal: string;
	workspaceRootReal: string;
}> {
	const lexicalRoots = [workspaceRoot, pluginRoot].map(root => path.resolve(root));
	const realRoots = await Promise.all(lexicalRoots.map(root => fs.realpath(root)));
	const untrustedRoots = [...new Set([...lexicalRoots, ...realRoots])];
	const candidates = [
		process.platform === "win32"
			? path.join(os.tmpdir(), "gjc-plugin-mcp-private")
			: path.join("/tmp", `gjc-plugin-mcp-${process.getuid?.() ?? process.pid}`),
	];
	for (const candidate of [...new Set(candidates.map(value => path.resolve(value)))]) {
		if (untrustedRoots.some(root => isWithin(root, candidate))) continue;
		try {
			await fs.mkdir(candidate, { recursive: true, mode: 0o700 });
			let lexicalStat = await fs.lstat(candidate);
			if (!lexicalStat.isDirectory() || lexicalStat.isSymbolicLink()) continue;
			if (process.platform !== "win32") {
				const uid = process.getuid?.();
				if (uid === undefined || lexicalStat.uid !== uid) continue;
				if ((lexicalStat.mode & 0o077) !== 0) {
					await fs.chmod(candidate, 0o700);
					lexicalStat = await fs.lstat(candidate);
					if ((lexicalStat.mode & 0o077) !== 0) continue;
				}
			}
			const real = await fs.realpath(candidate);
			if (untrustedRoots.some(root => isWithin(root, real))) continue;
			await reapStalePluginMcpCapsules(real);
			return { baseReal: real, workspaceRootReal: realRoots[0] };
		} catch {
			// An unavailable or unwritable base is not snapshot authority.
		}
	}
	throw new Error("Trusted plugin MCP snapshot base is unavailable outside untrusted roots");
}

async function reapStalePluginMcpCapsules(baseReal: string): Promise<void> {
	let entries: Dirent[];
	try {
		entries = await fs.readdir(baseReal, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const match = /^gjc-plugin-mcp-(\d+)-[a-f0-9]{32}$/u.exec(entry.name);
		if (!match) continue;
		const ownerPid = Number(match[1]);
		if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0 || ownerPid === process.pid) continue;
		try {
			process.kill(ownerPid, 0);
			continue;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") continue;
		}
		await fs.rm(path.join(baseReal, entry.name), { recursive: true, force: true }).catch(() => {});
	}
}

function verifiedStdioArgs(input: {
	launcher: "node" | "bun";
	entrypointPath: string;
	snapshotRoot: string;
	authorityPath: string;
	authorityHash: string;
	serverArgs: readonly string[];
}): string[] {
	return [
		...(input.launcher === "bun"
			? [`--config=${os.devNull}`, "--no-env-file", "--no-install"]
			: ["--input-type=module"]),
		"--eval",
		VERIFIED_STDIO_MODULE_WRAPPER,
		"--",
		input.entrypointPath,
		input.snapshotRoot,
		input.authorityPath,
		input.authorityHash,
		...input.serverArgs,
	];
}

async function prepareVerifiedStdioLaunch(input: {
	launcher: "node" | "bun";
	launcherPath: string;
	pluginRoot: string;
	cwdRelative: string;
	entrypointRelative: string;
	snapshotBaseReal: string;
	files: readonly GjcPluginRegistryEntry["copiedFiles"][number][];
	serverArgs: readonly string[];
	registerCleanup?: (cleanup: () => Promise<void>) => void;
}): Promise<MCPStdioPreparedLaunch> {
	if (process.platform !== "linux") {
		throw new Error("Authenticated plugin MCP stdio launch capsules are available only on Linux");
	}
	if (input.launcher === "bun") {
		throw new Error("Authenticated plugin MCP Bun launch capsules are unavailable");
	}
	const registerCleanup = input.registerCleanup;
	if (!registerCleanup) {
		throw new Error("Authenticated plugin MCP capsule cleanup ownership is unavailable");
	}
	if (input.files.length === 0 || input.files.length > MCP_SNAPSHOT_MAX_FILES) {
		throw new Error(`Plugin MCP snapshot file count exceeds ${MCP_SNAPSHOT_MAX_FILES}`);
	}
	let totalBytes = 0;
	for (const file of input.files) {
		if (!Number.isSafeInteger(file.bytes) || file.bytes < 0)
			throw new Error("Plugin MCP snapshot byte authority is invalid");
		totalBytes += file.bytes;
		if (totalBytes > MCP_SNAPSHOT_MAX_BYTES) {
			throw new Error(`Plugin MCP snapshot bytes exceed ${MCP_SNAPSHOT_MAX_BYTES}`);
		}
	}

	const capsuleRoot = path.join(
		input.snapshotBaseReal,
		`gjc-plugin-mcp-${process.pid}-${randomBytes(16).toString("hex")}`,
	);
	let cleanupComplete = false;
	let capsuleCreated = false;
	const cleanup = async () => {
		if (cleanupComplete || !capsuleCreated) return;
		await fs.rm(capsuleRoot, { recursive: true, force: true });
		cleanupComplete = true;
	};
	registerCleanup(cleanup);

	const snapshotRoot = path.join(capsuleRoot, "bundle");
	const authorityPath = path.join(capsuleRoot, "authority.json");
	const launcherPath = path.join(capsuleRoot, input.launcher);
	await fs.mkdir(capsuleRoot, { mode: 0o700 });
	capsuleCreated = true;
	await fs.mkdir(snapshotRoot, { mode: 0o700 });
	if ((await fs.realpath(capsuleRoot)) !== capsuleRoot) throw new Error("Plugin MCP launch capsule path drifted");

	const launcherBytes = await readStableFile(
		input.launcherPath,
		"Plugin MCP interpreter",
		MCP_LAUNCHER_MAX_BYTES,
		true,
	);
	const launcherReal = await fs.realpath(input.launcherPath);
	const expectedLauncherHash = (await initialNodeAuthorities).get(launcherReal);
	if (!expectedLauncherHash || sha256(launcherBytes) !== expectedLauncherHash) {
		throw new Error("Plugin MCP Node interpreter drifted from startup authority");
	}
	await fs.writeFile(launcherPath, launcherBytes, { flag: "wx", mode: 0o500 });
	await assertCapturedNodeRuntime(launcherPath);

	for (const file of input.files) {
		const sourcePath = resolveWithinRoot(input.pluginRoot, file.relativePath);
		const sourceReal = await fs.realpath(sourcePath);
		const pluginRootReal = await fs.realpath(input.pluginRoot);
		if (!isWithin(pluginRootReal, sourceReal))
			throw new Error(`Plugin MCP source escapes installed root: ${file.relativePath}`);
		const bytes = await readStableFile(sourceReal, `Plugin MCP source ${file.relativePath}`, MCP_SNAPSHOT_MAX_BYTES);
		if (bytes.byteLength !== file.bytes || sha256(bytes) !== file.sha256) {
			throw new Error(`Plugin MCP source hash drift: ${file.relativePath}`);
		}
		const destination = resolveWithinRoot(snapshotRoot, file.relativePath);
		await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
		await fs.writeFile(destination, bytes, { flag: "wx", mode: 0o400 });
	}

	const authorityBytes = Buffer.from(canonicalPersistedJson({ files: input.files }));
	await fs.writeFile(authorityPath, authorityBytes, { flag: "wx", mode: 0o400 });
	const cwd = input.cwdRelative === "" ? snapshotRoot : resolveWithinRoot(snapshotRoot, input.cwdRelative);
	await fs.mkdir(cwd, { recursive: true, mode: 0o500 });
	const entrypointPath = resolveWithinRoot(snapshotRoot, input.entrypointRelative);
	return {
		command: launcherPath,
		args: verifiedStdioArgs({
			launcher: input.launcher,
			entrypointPath,
			snapshotRoot,
			authorityPath,
			authorityHash: sha256(authorityBytes),
			serverArgs: input.serverArgs,
		}),
		cwd,
		afterProcessExit: cleanup,
	};
}

async function assertCapturedNodeRuntime(launcherPath: string): Promise<void> {
	const child = Bun.spawn(
		[
			launcherPath,
			"--input-type=module",
			"--eval",
			'if (process.versions.bun || process.release?.name !== "node") process.exit(42); process.stdout.write("gjc-node-authority\\n");',
		],
		{
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			env: { PATH: "", HOME: "", TMPDIR: path.dirname(launcherPath) },
		},
	);
	const outcome = await Promise.race([
		Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]),
		Bun.sleep(2_000).then(() => null),
	]);
	if (!outcome) {
		child.kill();
		await child.exited.catch(() => {});
		throw new Error("Plugin MCP Node interpreter identity check timed out");
	}
	const [exitCode, stdout] = outcome;
	if (exitCode !== 0 || stdout !== "gjc-node-authority\n") {
		throw new Error("Plugin MCP interpreter is not an authenticated Node runtime");
	}
}

async function hashFile(snapshot: FileSnapshot, expectedBytes: number): Promise<string> {
	const key = `${snapshot.path}:${snapshot.mtimeMs}:${snapshot.ctimeMs}:${snapshot.size}:${snapshot.ino}`;
	const cached = hashCache.get(key);
	if (cached) return cached;
	if (snapshot.size !== expectedBytes) throw new Error(`Installed file byte drift: ${snapshot.path}`);
	const digest = sha256(await readStableFile(snapshot.path, "Installed plugin file", expectedBytes));
	if (hashCache.size >= HASH_CACHE_MAX_ENTRIES) {
		// FIFO eviction is sufficient: the memo only avoids re-reads within a
		// session; correctness never depends on a hit.
		const oldest = hashCache.keys().next().value;
		if (oldest !== undefined) hashCache.delete(oldest);
	}
	hashCache.set(key, digest);
	return digest;
}

async function verifyEntryHashesCached(entry: GjcPluginRegistryEntry): Promise<SessionQuarantine | null> {
	for (const file of entry.copiedFiles) {
		let abs: string;
		try {
			abs = resolveWithinRoot(entry.pluginRoot, file.relativePath);
		} catch (error) {
			return {
				identity: bundleIdentity(entry.scope, entry.name),
				plugin: entry.name,
				surfaceId: `plugin:${entry.name}`,
				code: "runtime_mismatch",
				message: error instanceof Error ? error.message : String(error),
			};
		}
		const snapshot = await snapshotExistingFile(abs);
		if (!snapshot) {
			return {
				identity: bundleIdentity(entry.scope, entry.name),
				plugin: entry.name,
				surfaceId: `plugin:${entry.name}`,
				code: "runtime_mismatch",
				message: `Installed file missing: ${file.relativePath}`,
			};
		}
		let digest: string;
		try {
			digest = await hashFile(snapshot, file.bytes);
		} catch (error) {
			return {
				identity: bundleIdentity(entry.scope, entry.name),
				plugin: entry.name,
				surfaceId: `plugin:${entry.name}`,
				code: "runtime_mismatch",
				message: error instanceof Error ? error.message : String(error),
			};
		}
		if (digest !== file.sha256) {
			return {
				identity: bundleIdentity(entry.scope, entry.name),
				plugin: entry.name,
				surfaceId: `plugin:${entry.name}`,
				code: "runtime_mismatch",
				message: `Installed file hash drift: ${file.relativePath}`,
			};
		}
	}
	return null;
}

async function assertMcpPluginRootOwnedByScope(entry: GjcPluginRegistryEntry, cwd: string): Promise<void> {
	const scopeRoot = path.resolve(registryRootForScope(entry.scope, cwd));
	const pluginRoot = path.resolve(entry.pluginRoot);
	const expectedPluginRoot = path.resolve(gjcPluginInstallRoot(entry.scope, cwd, entry.name));
	if (pluginRoot !== expectedPluginRoot) {
		throw new Error(
			`Installed plugin root does not match its canonical ${entry.scope} identity: ${entry.pluginRoot}`,
		);
	}
	if (!isWithin(scopeRoot, pluginRoot)) {
		throw new Error(`Installed plugin root escapes its ${entry.scope} registry scope: ${entry.pluginRoot}`);
	}
	const [scopeRootReal, pluginRootReal, expectedPluginRootReal] = await Promise.all([
		fs.realpath(scopeRoot),
		fs.realpath(pluginRoot),
		fs.realpath(expectedPluginRoot),
	]);
	if (pluginRootReal !== expectedPluginRootReal) {
		throw new Error(
			`Installed plugin real root does not match its canonical ${entry.scope} identity: ${entry.pluginRoot}`,
		);
	}
	if (!isWithin(scopeRootReal, pluginRootReal)) {
		throw new Error(`Installed plugin root escapes its ${entry.scope} registry scope: ${entry.pluginRoot}`);
	}
}

async function assertInstalledTreeAuthenticated(entry: GjcPluginRegistryEntry): Promise<void> {
	const expected = new Set(entry.copiedFiles.map(file => path.normalize(file.relativePath)));
	const visit = async (directory: string): Promise<void> => {
		let children: Dirent[];
		try {
			children = await fs.readdir(directory, { withFileTypes: true });
		} catch (error) {
			throw new Error(
				`Installed plugin tree is unreadable: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
			const absolutePath = path.join(directory, child.name);
			const relativePath = path.normalize(path.relative(entry.pluginRoot, absolutePath));
			if (child.isSymbolicLink()) throw new Error(`Installed plugin tree contains a symlink: ${relativePath}`);
			if (child.isDirectory()) {
				await visit(absolutePath);
				continue;
			}
			if (!child.isFile()) throw new Error(`Installed plugin tree contains an unsupported entry: ${relativePath}`);
			if (!expected.delete(relativePath)) {
				throw new Error(`Installed plugin tree contains an unauthenticated file: ${relativePath}`);
			}
		}
	};
	await visit(entry.pluginRoot);
	if (expected.size > 0) {
		throw new Error(`Installed plugin tree is missing authenticated files: ${[...expected].sort().join(", ")}`);
	}
}

async function loadValidatedPluginRegistry(cwd: string, forceRefresh = false): Promise<ValidatedPluginRegistry> {
	const registryFiles = await snapshotRegistryFiles(cwd);
	const registryKey = snapshotsKey(registryFiles);
	const cached = validatedRegistryCache.get(cwd);
	if (!forceRefresh && cached && cached.registryKey === registryKey) {
		const pluginFiles = await snapshotPluginFiles(cached.effective);
		const pluginKey = snapshotsKey(pluginFiles);
		if (cached.pluginKey === pluginKey) return cached;
	}

	const effective = await loadEffectiveGjcPluginRegistry(cwd, forceRefresh ? { migrate: false } : undefined);
	const currentRegistryFiles = await snapshotRegistryFiles(cwd);
	const preQuarantine: SessionQuarantine[] = [];
	for (const entry of effective) {
		if (!entry.enabled) continue;
		const drift = await verifyEntryHashesCached(entry);
		if (drift) preQuarantine.push(drift);
	}
	const validation = validateSessionBundles(effective, {}, preQuarantine);
	const pluginFiles = await snapshotPluginFiles(effective);
	const next: CachedValidatedPluginRegistry = {
		effective,
		active: validation.active,
		quarantine: validation.quarantine,
		validation,
		registryFiles: currentRegistryFiles,
		pluginFiles,
		registryKey: snapshotsKey(currentRegistryFiles),
		pluginKey: snapshotsKey(pluginFiles),
	};
	validatedRegistryCache.set(cwd, next);
	return next;
}

/**
 * Load the always-on plugin tool surfaces for the effective registry at `cwd`.
 *
 * Safety properties:
 * - Hash drift quarantines the plugin (runtime_mismatch) before any import.
 * - Session-start collisions vs reserved/built-in names quarantine fail-closed.
 * - Manifest-declared tool names are authoritative: a factory that returns a
 *   different/extra/missing name is rejected with runtime_mismatch and skipped.
 * - Reserved tool names are never overwritten.
 *
 * Returns an empty result when no plugins are installed, so callers that always
 * call this in `createAgentSession` incur no behavior change without plugins.
 */
export async function loadAlwaysOnPluginTools(input: {
	cwd: string;
	reservedToolNames: string[];
	declarations?: readonly GjcPluginToolDeclaration[];
	/** Test seam runs before the final per-import integrity guard. */
	beforeImport?: (resolvedPath: string) => Promise<void>;
}): Promise<AlwaysOnPluginTools> {
	const validated = await loadValidatedPluginRegistry(input.cwd);
	const { effective } = validated;
	if (effective.length === 0) return { tools: [], quarantine: [] };

	const reserved = new Set(input.reservedToolNames);
	const { active, quarantine } = validateSessionBundles(
		effective,
		{ toolNames: input.reservedToolNames },
		validated.quarantine,
	);

	// Map declared (path -> name) for every active always-on tool surface.
	const declaredMetadata = new Map(
		(input.declarations ?? []).map(surface => [`${surface.scope}:${surface.plugin}:${surface.extensionId}`, surface]),
	);
	const declared = new Map<
		string,
		{
			name: string;
			plugin: string;
			scope: GjcPluginScope;
			pluginRoot: string;
			relativePath: string;
			implementationHash?: string;
		}
	>();
	for (const entry of active) {
		const disabled = new Set(entry.disabledSurfaceIds);
		for (const t of entry.surfaces.tools) {
			if (disabled.has(t.extensionId)) continue;
			let implementationPath: string;
			try {
				implementationPath = await resolveRuntimeFile(entry.pluginRoot, t.relativePath);
			} catch (error) {
				quarantine.push({
					identity: bundleIdentity(entry.scope, entry.name),
					plugin: entry.name,
					surfaceId: t.extensionId,
					code: "runtime_mismatch",
					message: error instanceof Error ? error.message : String(error),
				});
				continue;
			}
			const metadata = declaredMetadata.get(`${entry.scope}:${entry.name}:${t.extensionId}`);
			declared.set(implementationPath, {
				name: t.name,
				plugin: entry.name,
				scope: entry.scope,
				pluginRoot: entry.pluginRoot,
				relativePath: t.relativePath,
				implementationHash:
					metadata?.implementationHash ??
					("implementationHash" in t && typeof t.implementationHash === "string"
						? t.implementationHash
						: undefined),
			});
		}
	}
	if (declared.size === 0) return { tools: [], quarantine };

	// Declaration and activation are separate: all metadata is read first, then
	// each implementation is hash-checked immediately before the single import.
	for (const [declaredPath, info] of [...declared]) {
		if (!info.implementationHash) continue;
		try {
			await verifyImplementationHash(declaredPath, info.implementationHash);
		} catch (error) {
			quarantine.push({
				identity: bundleIdentity(info.scope, info.plugin),
				plugin: info.plugin,
				surfaceId: `tool:${info.name}`,
				code:
					error instanceof Error && "code" in error && (error as { code?: unknown }).code === "hash_mismatch"
						? "runtime_mismatch"
						: "runtime_mismatch",
				message: error instanceof Error ? error.message : String(error),
			});
			declared.delete(declaredPath);
		}
	}
	if (declared.size === 0) return { tools: [], quarantine };
	const loaded = await loadCustomTools(
		[...declared.keys()].map(p => ({ path: p })),
		input.cwd,
		input.reservedToolNames,
		undefined,
		async resolvedPath => {
			await input.beforeImport?.(resolvedPath);
			const info = declared.get(path.resolve(resolvedPath));
			if (!info?.implementationHash) throw new Error(`Unregistered or unhashed GJC tool import: ${resolvedPath}`);
			const finalPath = await resolveRuntimeFile(info.pluginRoot, info.relativePath);
			if (path.resolve(finalPath) !== path.resolve(resolvedPath))
				throw new Error(`GJC tool path drifted before import: ${info.relativePath}`);
			await verifyImplementationHash(finalPath, info.implementationHash);
		},
	);

	// Group loaded tools by their source path for exact-name verification.
	const byPath = new Map<string, string[]>();
	for (const lt of loaded.tools) {
		const key = path.resolve(lt.path);
		const list = byPath.get(key) ?? [];
		list.push(lt.tool.name);
		byPath.set(key, list);
	}

	const tools: CustomTool[] = [];
	const seenNames = new Set<string>(reserved);
	for (const [declaredPath, info] of declared) {
		const returned = byPath.get(path.resolve(declaredPath)) ?? [];
		// Manifest is authoritative: exactly the one declared name must come back.
		if (returned.length !== 1 || returned[0] !== info.name) {
			quarantine.push({
				identity: bundleIdentity(info.scope, info.plugin),
				plugin: info.plugin,
				surfaceId: `tool:${info.name}`,
				code: "runtime_mismatch",
				message: `Tool factory returned ${JSON.stringify(returned)}, expected exactly ["${info.name}"]`,
			});
			continue;
		}
		if (seenNames.has(info.name)) {
			// Defense in depth: never overwrite a reserved/earlier name.
			quarantine.push({
				identity: bundleIdentity(info.scope, info.plugin),
				plugin: info.plugin,
				surfaceId: `tool:${info.name}`,
				code: "session_collision",
				message: `Tool name "${info.name}" already present; refusing to overwrite`,
			});
			continue;
		}
		const match = loaded.tools.find(lt => path.resolve(lt.path) === path.resolve(declaredPath));
		if (match) {
			tools.push(match.tool);
			seenNames.add(info.name);
		}
	}
	return { tools, quarantine };
}

/**
 * Render the always-on system-appendix blocks for the effective registry at
 * `cwd`, applying hash-drift + collision quarantine first. Returns "" when no
 * plugins are installed/enabled. Safe to call unconditionally at session start.
 */
export async function renderAlwaysOnSystemAppendices(input: { cwd: string }): Promise<string> {
	const { effective, active } = await loadValidatedPluginRegistry(input.cwd);
	if (effective.length === 0) return "";
	const { renderPluginAppendices } = await import("./prompt-appendix");
	return (await renderPluginAppendices(active)).system;
}

/**
 * Render the agent-appendix block and Tier-1 sub-skill advertisement for a role
 * agent at session/spawn time. Hash-drift + collision quarantine applied first.
 * Returns empty strings when nothing applies.
 */
export async function renderAgentPromptAdditions(input: {
	cwd: string;
	agentName: string;
}): Promise<{ appendix: string; advertisement: string }> {
	const { effective, active } = await loadValidatedPluginRegistry(input.cwd);
	if (effective.length === 0) return { appendix: "", advertisement: "" };
	const { renderPluginAppendices } = await import("./prompt-appendix");
	const { buildAgentSubskillAdvertisement } = await import("./injection");
	const rendered = await renderPluginAppendices(active);
	return {
		appendix: rendered.byAgent.get(input.agentName as never) ?? "",
		advertisement: buildAgentSubskillAdvertisement(active, input.agentName),
	};
}

/**
 * Render the Tier-1 sub-skill advertisement for a workflow parent skill.
 * Returns "" when nothing applies. Quarantine applied first.
 */
export async function renderSkillAdvertisement(input: {
	cwd: string;
	skillName: string;
	phase?: string;
}): Promise<string> {
	const { effective, active } = await loadValidatedPluginRegistry(input.cwd);
	if (effective.length === 0) return "";
	const { buildSubskillAdvertisement } = await import("./injection");
	return buildSubskillAdvertisement(active, input.skillName, input.phase);
}

/**
 * Convert active plugin-bundle MCP surfaces into runtime MCPServerConfig entries,
 * applying install + runtime MCP policy (URL scheme/private-range deny, DNS
 * re-resolution for http/sse, stdio root-confinement) before connection. Servers
 * failing policy are quarantined and excluded. Returns {} when none.
 */
export async function buildPluginMcpConfigs(input: { cwd: string }): Promise<{
	configs: Record<string, any>;
	quarantine: SessionQuarantine[];
}> {
	const { effective, active, quarantine } = await loadValidatedPluginRegistry(input.cwd, true);
	if (effective.length === 0) return { configs: {}, quarantine: [] };

	// A manifest-controlled MCP name such as "constructor" or "toString" must
	// remain an ordinary own key rather than interacting with Object.prototype.
	const configs: Record<string, any> = Object.create(null) as Record<string, any>;
	for (const entry of active) {
		const disabled = new Set(entry.disabledSurfaceIds);
		let compiledMcps: Map<string, (typeof entry.surfaces.mcps)[number]> | undefined;
		let compileError: unknown;
		try {
			await assertMcpPluginRootOwnedByScope(entry, input.cwd);
			await assertInstalledTreeAuthenticated(entry);
			const compiled = await compileGjcPluginBundle(entry.pluginRoot);
			if (
				compiled.name !== entry.name ||
				compiled.version !== entry.version ||
				compiled.manifestHash !== entry.manifestHash ||
				canonicalPersistedJson(compiled.files) !== canonicalPersistedJson(entry.copiedFiles)
			) {
				throw new Error(`Installed plugin bundle identity does not match registry entry: ${entry.name}`);
			}
			compiledMcps = new Map(compiled.surfaces.mcps.map(surface => [surface.extensionId, surface]));
		} catch (error) {
			compileError = error;
		}
		for (const m of entry.surfaces.mcps) {
			if (disabled.has(m.extensionId)) continue;
			const cfg = m.config;
			try {
				if (compileError) throw compileError;
				const compiled = compiledMcps?.get(m.extensionId);
				if (
					!compiled ||
					compiled.name !== m.name ||
					compiled.extensionId !== m.extensionId ||
					m.configHash !== compiled.configHash ||
					canonicalPersistedJson(cfg) !== canonicalPersistedJson(compiled.config)
				) {
					throw new Error(`MCP "${m.name}": persisted config no longer matches its compiled manifest`);
				}
				assertMcpInstallPolicy(cfg, { pluginRoot: entry.pluginRoot });
				if (cfg.transport === "stdio") {
					if (process.platform !== "linux") {
						throw new Error("Authenticated plugin MCP stdio launch capsules are available only on Linux");
					}
					const invocation = classifyStdioInvocation(cfg, { pluginRoot: entry.pluginRoot });
					for (const relativePath of invocation.ownedRelativePaths) {
						const ownedFile = entry.copiedFiles.find(
							file => path.normalize(file.relativePath) === path.normalize(relativePath),
						);
						if (!ownedFile) {
							throw new Error(
								`MCP "${m.name}": selected file is not in the authenticated copied-file set: ${relativePath}`,
							);
						}
					}
					const ownedFile = entry.copiedFiles.find(
						file => path.normalize(file.relativePath) === path.normalize(invocation.ownedRelativePath),
					);
					if (!ownedFile) throw new Error(`MCP "${m.name}": authenticated entrypoint record is missing`);
					const command = await resolveTrustedStdioLauncher(invocation.launcher, input.cwd, entry.pluginRoot);
					const initialArgs = [...(cfg.args ?? [])];
					configs[m.name] = {
						type: "stdio",
						command,
						args: initialArgs,
						cwd: invocation.cwd,
						timeout: 5_000,
						// Third-party plugin MCP processes must not inherit host secrets;
						// only a minimal OS allowlist (PATH/HOME/temp/locale) is provided.
						noInheritEnv: true,
						prepareSpawn: async (launch: MCPStdioSpawnLaunch) => {
							const [launchCwdReal, expectedInitialCwdReal] = await Promise.all([
								fs.realpath(launch.cwd),
								fs.realpath(invocation.cwd),
							]);
							if (
								launch.command !== command ||
								launchCwdReal !== expectedInitialCwdReal ||
								canonicalPersistedJson(launch.args) !== canonicalPersistedJson(initialArgs)
							) {
								throw new Error(`MCP "${m.name}": launch plan drifted before preparation`);
							}
							await assertMcpPluginRootOwnedByScope(entry, input.cwd);
							await assertInstalledTreeAuthenticated(entry);
							const freshBundle = await compileGjcPluginBundle(entry.pluginRoot);
							if (
								freshBundle.name !== entry.name ||
								freshBundle.version !== entry.version ||
								freshBundle.manifestHash !== entry.manifestHash ||
								canonicalPersistedJson(freshBundle.files) !== canonicalPersistedJson(entry.copiedFiles)
							) {
								throw new Error(`MCP "${m.name}": installed bundle identity/files drifted before spawn`);
							}
							const freshSurface = freshBundle.surfaces.mcps.find(
								surface => surface.extensionId === m.extensionId,
							);
							if (
								!freshSurface ||
								freshSurface.name !== m.name ||
								freshSurface.extensionId !== m.extensionId ||
								freshSurface.configHash !== m.configHash ||
								canonicalPersistedJson(freshSurface.config) !== canonicalPersistedJson(cfg)
							) {
								throw new Error(`MCP "${m.name}": installed manifest/config drifted before spawn`);
							}
							const freshInvocation = classifyStdioInvocation(freshSurface.config, {
								pluginRoot: entry.pluginRoot,
							});
							for (const relativePath of freshInvocation.ownedRelativePaths) {
								const freshOwnedFile = entry.copiedFiles.find(
									file => path.normalize(file.relativePath) === path.normalize(relativePath),
								);
								if (!freshOwnedFile) {
									throw new Error(
										`MCP "${m.name}": unauthenticated installed file selected before spawn: ${relativePath}`,
									);
								}
								const freshPath = await resolveRuntimeFile(entry.pluginRoot, freshOwnedFile.relativePath);
								await verifyImplementationHash(freshPath, freshOwnedFile.sha256);
							}
							const freshOwnedFile = entry.copiedFiles.find(
								file => path.normalize(file.relativePath) === path.normalize(freshInvocation.ownedRelativePath),
							);
							if (!freshOwnedFile)
								throw new Error(`MCP "${m.name}": authenticated entrypoint drifted before spawn`);
							const freshCommand = await resolveTrustedStdioLauncher(
								freshInvocation.launcher,
								input.cwd,
								entry.pluginRoot,
							);
							const { baseReal: snapshotBaseReal } = await resolveTrustedSnapshotBase(
								input.cwd,
								entry.pluginRoot,
							);
							return prepareVerifiedStdioLaunch({
								launcher: freshInvocation.launcher,
								launcherPath: freshCommand,
								pluginRoot: entry.pluginRoot,
								cwdRelative: path.relative(entry.pluginRoot, freshInvocation.cwd),
								entrypointRelative: freshOwnedFile.relativePath,
								snapshotBaseReal,
								files: entry.copiedFiles,
								serverArgs: (freshSurface.config.args ?? []).slice(1),
								registerCleanup: launch.registerCleanup,
							});
						},
					};
				} else {
					const url = assertUrlAllowed(cfg.url ?? "", `MCP "${m.name}" url`);
					await assertDnsResolvesPublic(url.hostname, `MCP "${m.name}" host`);
					// Headers are intentionally NOT forwarded: the generic MCP config
					// resolution path expands ${env:...}/shell templates, which would let
					// a third-party bundle exfiltrate host secrets. Plugin-bundle MCP
					// servers connect without bundle-declared headers.
					configs[m.name] = bindPluginMcpToPublicNetwork({ type: cfg.transport, url: url.toString() });
				}
			} catch (error) {
				quarantine.push({
					identity: bundleIdentity(entry.scope, entry.name),
					plugin: entry.name,
					surfaceId: m.extensionId,
					code: "security_policy",
					message: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}
	return { configs, quarantine };
}
