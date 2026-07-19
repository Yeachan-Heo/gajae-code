import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir } from "@gajae-code/utils";
import { repo } from "../utils/git";
import {
	FILESYSTEM_MEMORY_MAX_INSPECTED_ENTRIES,
	FILESYSTEM_MEMORY_PRIVATE_FILE_MODE,
	FILESYSTEM_MEMORY_PROTOCOL_VERSION,
	type FilesystemMemoryCheckpointV1,
	type FilesystemMemoryIdentityRegistryV1,
	type FilesystemMemoryInitializationMarkerV1,
	type FilesystemMemoryMapV1,
	type FilesystemMemoryOutcome,
	type FilesystemMemoryRepositoryPolicyV1,
	type FilesystemMemoryScope,
	type FilesystemMemoryScopeAvailability,
	type FilesystemMemoryUserPolicyV1,
} from "./contracts";
import {
	enrollFilesystemMemoryProjectIdentity,
	ensureFilesystemMemoryPrivateDirectory,
	getFilesystemMemoryDataDir,
	getFilesystemMemoryRegistryPath,
	resolveFilesystemMemoryProjectIdentity,
} from "./identity";
import { listSafeFilesystemMemoryDirectory, readSafeFilesystemMemoryFile } from "./safe-path";
import { resolveFilesystemMemoryScopeAvailability } from "./scopes";
import { formatFilesystemMemoryUri } from "./uri";

const SCOPES: readonly FilesystemMemoryScope[] = ["global", "project", "project-local", "session"];
const MARKER = "initialization.v1.json";
const POLICY = "policy.v1.json";
const MAX_CHECKPOINT_BYTES = 256 * 1024;
const MAX_CHECKPOINTS = 256;
const ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;

export interface FilesystemMemoryRoots {
	readonly roots: Partial<Record<FilesystemMemoryScope, string>>;
	readonly availability: readonly FilesystemMemoryScopeAvailability[];
	readonly projectId?: string;
}
export interface FilesystemMemoryCheckpointInput {
	readonly taskId: string;
	readonly sessionId: string;
	readonly content: string;
	readonly expectedDigest?: string | null;
}
export interface FilesystemMemoryCheckpointResult {
	readonly uri: string;
	readonly digest: string;
	readonly checkpoint: FilesystemMemoryCheckpointV1;
}
export interface FilesystemMemoryResumeResult extends FilesystemMemoryCheckpointResult {
	readonly verificationRequired: true;
}

function fail(
	code: Exclude<FilesystemMemoryOutcome<never>["code"], "ok">,
	message: string,
): FilesystemMemoryOutcome<never> {
	return { code, message };
}
function json(value: unknown): string {
	return `${JSON.stringify(value, null, 2)}\n`;
}
function digest(value: string): string {
	return crypto.createHash("sha256").update(value).digest("hex");
}
function canonicalId(value: string): string | null {
	const normalized = value.trim().toLowerCase();
	return ID.test(normalized) ? normalized : null;
}

async function readJson<T>(file: string, fallback: T): Promise<FilesystemMemoryOutcome<T>> {
	const root = path.dirname(file);
	try {
		const rootStat = await fs.lstat(root);
		if (rootStat.isSymbolicLink() || !rootStat.isDirectory())
			return fail("symlink_denied", `Filesystem memory directory is unsafe: ${path.basename(root)}.`);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { code: "ok", value: fallback };
		return fail("permission_denied", `Filesystem memory directory cannot be inspected: ${path.basename(root)}.`);
	}
	const read = await readSafeFilesystemMemoryFile(root, [path.basename(file)]);
	if (read.code === "not_found") return { code: "ok", value: fallback };
	if (read.code !== "ok") return read;
	try {
		const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(read.value.bytes));
		if (
			!value ||
			typeof value !== "object" ||
			(value as { version?: unknown }).version !== FILESYSTEM_MEMORY_PROTOCOL_VERSION
		)
			return fail("unknown_version", `Unsupported or malformed filesystem memory document: ${path.basename(file)}.`);
		return { code: "ok", value: value as T };
	} catch {
		return fail("invalid_path", `Filesystem memory document cannot be read: ${path.basename(file)}.`);
	}
}

const REGISTRY_KEY = /^[0-9a-f]{64}$/;
const PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isIdentityRegistry(value: unknown): value is FilesystemMemoryIdentityRegistryV1 {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const candidate = value as { version?: unknown; repositories?: unknown };
	if (
		candidate.version !== FILESYSTEM_MEMORY_PROTOCOL_VERSION ||
		!candidate.repositories ||
		typeof candidate.repositories !== "object" ||
		Array.isArray(candidate.repositories)
	)
		return false;
	const entries = Object.entries(candidate.repositories as Record<string, unknown>);
	if (entries.length > FILESYSTEM_MEMORY_MAX_INSPECTED_ENTRIES) return false;
	return entries.every(([key, entry]) => {
		if (!REGISTRY_KEY.test(key) || !entry || typeof entry !== "object" || Array.isArray(entry)) return false;
		const identity = entry as {
			projectId?: unknown;
			commonDir?: unknown;
			remoteDisplay?: unknown;
			enrolledAt?: unknown;
		};
		return (
			typeof identity.projectId === "string" &&
			PROJECT_ID.test(identity.projectId) &&
			typeof identity.commonDir === "string" &&
			path.isAbsolute(identity.commonDir) &&
			(identity.remoteDisplay === null || typeof identity.remoteDisplay === "string") &&
			typeof identity.enrolledAt === "string"
		);
	});
}

async function readIdentityRegistry(
	file: string,
): Promise<FilesystemMemoryOutcome<FilesystemMemoryIdentityRegistryV1>> {
	const result = await readJson<unknown>(file, { version: 1, repositories: {} });
	if (result.code !== "ok") return result;
	return isIdentityRegistry(result.value)
		? { code: "ok", value: result.value }
		: fail("invalid_path", "Filesystem memory identity registry is malformed.");
}

async function acquireLock(directory: string): Promise<FilesystemMemoryOutcome<fs.FileHandle>> {
	const file = path.join(directory, ".filesystem-memory.lock");
	for (let attempt = 0; attempt < 20; attempt += 1) {
		try {
			return { code: "ok", value: await fs.open(file, "wx", FILESYSTEM_MEMORY_PRIVATE_FILE_MODE) };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST")
				return fail("permission_denied", "Filesystem memory lock cannot be acquired.");
			await Bun.sleep(25);
		}
	}
	return fail("topology_changed", "Filesystem memory lock timed out.");
}

async function releaseLock(directory: string, lock: fs.FileHandle): Promise<void> {
	try {
		await lock.close();
	} finally {
		await fs.rm(path.join(directory, ".filesystem-memory.lock"), { force: true }).catch(() => undefined);
	}
}

async function atomicWriteUnlocked(
	file: string,
	content: string,
	mode: number = FILESYSTEM_MEMORY_PRIVATE_FILE_MODE,
): Promise<FilesystemMemoryOutcome<void>> {
	const directory = path.dirname(file);
	const temp = path.join(directory, `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
	let handle: fs.FileHandle | undefined;
	try {
		handle = await fs.open(temp, "wx", mode);
		await handle.writeFile(content, "utf8");
		await handle.sync();
		await handle.close();
		handle = undefined;
		await fs.rename(temp, file);
		return { code: "ok", value: undefined };
	} catch {
		return fail("permission_denied", `Filesystem memory file could not be written: ${path.basename(file)}.`);
	} finally {
		if (handle) await handle.close();
		await fs.rm(temp, { force: true }).catch(() => undefined);
	}
}

async function atomicWrite(
	file: string,
	content: string,
	mode: number = FILESYSTEM_MEMORY_PRIVATE_FILE_MODE,
): Promise<FilesystemMemoryOutcome<void>> {
	const directory = path.dirname(file);
	const lock = await acquireLock(directory);
	if (lock.code !== "ok") return lock;
	try {
		return await atomicWriteUnlocked(file, content, mode);
	} finally {
		await releaseLock(directory, lock.value);
	}
}

function isInitializationMarker(value: unknown): value is FilesystemMemoryInitializationMarkerV1 {
	if (!value || typeof value !== "object") return false;
	const marker = value as { version?: unknown; initializedAt?: unknown; scopes?: unknown };
	return (
		marker.version === FILESYSTEM_MEMORY_PROTOCOL_VERSION &&
		typeof marker.initializedAt === "string" &&
		Array.isArray(marker.scopes) &&
		marker.scopes.every(
			(scope: unknown) => typeof scope === "string" && SCOPES.includes(scope as FilesystemMemoryScope),
		)
	);
}

async function readInitializationMarker(
	root: string,
): Promise<FilesystemMemoryOutcome<FilesystemMemoryInitializationMarkerV1 | null>> {
	const read = await readSafeFilesystemMemoryFile(root, [MARKER]);
	if (read.code === "not_found") return { code: "ok", value: null };
	if (read.code !== "ok") return read;
	try {
		const value: unknown = JSON.parse(new TextDecoder().decode(read.value.bytes));
		if (!isInitializationMarker(value))
			return fail("unknown_version", `Unsupported or malformed filesystem memory document: ${MARKER}.`);
		return { code: "ok", value };
	} catch {
		return fail("unknown_version", `Unsupported or malformed filesystem memory document: ${MARKER}.`);
	}
}

async function readPolicy<T extends FilesystemMemoryUserPolicyV1 | FilesystemMemoryRepositoryPolicyV1>(
	root: string,
): Promise<FilesystemMemoryOutcome<T | null>> {
	const read = await readSafeFilesystemMemoryFile(root, [POLICY]);
	if (read.code === "not_found") return { code: "ok", value: null };
	if (read.code !== "ok") return read;
	try {
		const value: unknown = JSON.parse(new TextDecoder().decode(read.value.bytes));
		if (!value || typeof value !== "object")
			return fail("unknown_version", `Unsupported or malformed filesystem memory document: ${POLICY}.`);
		return { code: "ok", value: value as T };
	} catch {
		return fail("unknown_version", `Unsupported or malformed filesystem memory document: ${POLICY}.`);
	}
}

async function rawFilesystemMemoryRoots(
	cwd: string,
	agentDir: string,
): Promise<FilesystemMemoryOutcome<FilesystemMemoryRoots>> {
	const data = getFilesystemMemoryDataDir(agentDir);
	const registry = await readIdentityRegistry(getFilesystemMemoryRegistryPath(agentDir));
	if (registry.code !== "ok") return registry;
	const identity = await resolveFilesystemMemoryProjectIdentity({ cwd, registry: registry.value, agentDir });
	if (identity.code === "identity_drift") return identity;
	const roots: Partial<Record<FilesystemMemoryScope, string>> = { global: path.join(data, "global") };
	if (identity.code === "ok") {
		roots.project = identity.value.sharedRoot;
		roots["project-local"] = path.join(identity.value.privateRoot, "project-local");
		roots.session = path.join(identity.value.privateRoot, "sessions");
	}
	return {
		code: "ok",
		value: { roots, availability: [], ...(identity.code === "ok" ? { projectId: identity.value.projectId } : {}) },
	};
}

function unavailableScope(roots: FilesystemMemoryRoots, scope: FilesystemMemoryScope): FilesystemMemoryOutcome<never> {
	const reason = roots.availability.find(entry => entry.scope === scope)?.reason;
	return fail(reason && reason !== "ok" ? reason : "identity_unavailable", `Scope ${scope} is unavailable.`);
}

export async function getFilesystemMemoryRoots(
	cwd: string = process.cwd(),
	agentDir: string = getAgentDir(),
): Promise<FilesystemMemoryOutcome<FilesystemMemoryRoots>> {
	const raw = await rawFilesystemMemoryRoots(cwd, agentDir);
	if (raw.code !== "ok") return raw;
	const userPolicyResult = await readPolicy<FilesystemMemoryUserPolicyV1>(getFilesystemMemoryDataDir(agentDir));
	if (userPolicyResult.code !== "ok") return userPolicyResult;
	const userPolicy: FilesystemMemoryUserPolicyV1 = userPolicyResult.value ?? { version: 1, allowedScopes: SCOPES };
	const repositoryPolicyResult = raw.value.roots.project
		? await readPolicy<FilesystemMemoryRepositoryPolicyV1>(raw.value.roots.project)
		: ({ code: "ok", value: null } as const);
	if (repositoryPolicyResult.code !== "ok") return repositoryPolicyResult;
	const initialized = new Set<FilesystemMemoryScope>();
	for (const scope of SCOPES) {
		const root = raw.value.roots[scope];
		if (!root) continue;
		const marker = await readInitializationMarker(root);
		if (marker.code !== "ok") return marker;
		if (marker.value?.scopes.includes(scope)) initialized.add(scope);
	}
	const availability = resolveFilesystemMemoryScopeAvailability(userPolicy, repositoryPolicyResult.value, initialized);
	const roots: Partial<Record<FilesystemMemoryScope, string>> = {};
	for (const entry of availability) {
		const root = raw.value.roots[entry.scope];
		if (entry.available && root) roots[entry.scope] = root;
	}
	return {
		code: "ok",
		value: { roots, availability, ...(raw.value.projectId ? { projectId: raw.value.projectId } : {}) },
	};
}

async function writeIfMissing(
	file: string,
	content: string,
	privateFile: boolean,
): Promise<FilesystemMemoryOutcome<void>> {
	try {
		const stat = await fs.lstat(file);
		if (stat.isSymbolicLink()) return fail("symlink_denied", "Filesystem memory path must not be a symbolic link.");
		if (!stat.isFile()) return fail("invalid_path", "Filesystem memory path must be a regular file.");
		return { code: "ok", value: undefined };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT")
			return fail("permission_denied", "Filesystem memory path cannot be inspected.");
	}
	return atomicWrite(file, content, privateFile ? FILESYSTEM_MEMORY_PRIVATE_FILE_MODE : 0o644);
}

async function ensureFilesystemMemoryProjectDirectory(root: string): Promise<FilesystemMemoryOutcome<string>> {
	const absolute = path.resolve(root);
	const projectAgentDir = path.dirname(absolute);
	const worktreeRoot = path.dirname(projectAgentDir);
	if (path.basename(absolute) !== "memory" || path.basename(projectAgentDir) !== ".gjc")
		return fail("invalid_path", "Repository-shared memory root has an invalid shape.");
	try {
		const worktreeStat = await fs.lstat(worktreeRoot);
		if (
			worktreeStat.isSymbolicLink() ||
			!worktreeStat.isDirectory() ||
			(await fs.realpath(worktreeRoot)) !== worktreeRoot
		)
			return fail("symlink_denied", "Git worktree root is not a trusted directory.");
		for (const directory of [projectAgentDir, absolute]) {
			try {
				await fs.mkdir(directory, { mode: 0o755 });
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			}
			const stat = await fs.lstat(directory);
			if (stat.isSymbolicLink() || !stat.isDirectory() || (await fs.realpath(directory)) !== directory)
				return fail("symlink_denied", "Repository-shared memory path contains a symbolic link.");
		}
		return { code: "ok", value: absolute };
	} catch {
		return fail("permission_denied", "Repository-shared memory directory could not be secured.");
	}
}

export async function initializeFilesystemMemory(
	scopes: readonly FilesystemMemoryScope[] = SCOPES,
	cwd: string = process.cwd(),
	agentDir: string = getAgentDir(),
): Promise<FilesystemMemoryOutcome<FilesystemMemoryRoots>> {
	if (!scopes.length || scopes.some(scope => !SCOPES.includes(scope)))
		return fail("invalid_path", "Initialization scopes are invalid.");
	const data = getFilesystemMemoryDataDir(agentDir);
	const secured = await ensureFilesystemMemoryPrivateDirectory(data);
	if (secured.code !== "ok") return secured;
	const registryPath = getFilesystemMemoryRegistryPath(agentDir);
	const registry = await readIdentityRegistry(registryPath);
	if (registry.code !== "ok") return registry;
	let enrolled = registry.value;
	if (scopes.some(scope => scope !== "global")) {
		const repository = await repo.resolve(cwd);
		if (!repository) return fail("identity_unavailable", "Project scopes require a Git worktree.");
		let commonDir: string;
		try {
			commonDir = await fs.realpath(repository.commonDir);
		} catch {
			return fail("identity_unavailable", "Git common directory cannot be resolved.");
		}
		enrolled = enrollFilesystemMemoryProjectIdentity(enrolled, commonDir, null, new Date().toISOString());
		const saved = await atomicWrite(registryPath, json(enrolled));
		if (saved.code !== "ok") return saved;
	}
	const roots = await rawFilesystemMemoryRoots(cwd, agentDir);
	if (roots.code !== "ok") return roots;
	const userPolicyResult = await readPolicy<FilesystemMemoryUserPolicyV1>(data);
	if (userPolicyResult.code !== "ok") return userPolicyResult;
	const userPolicy: FilesystemMemoryUserPolicyV1 = userPolicyResult.value ?? { version: 1, allowedScopes: SCOPES };
	const repositoryPolicyResult = roots.value.roots.project
		? await readPolicy<FilesystemMemoryRepositoryPolicyV1>(roots.value.roots.project)
		: ({ code: "ok", value: null } as const);
	if (repositoryPolicyResult.code !== "ok") return repositoryPolicyResult;
	const policyAvailability = resolveFilesystemMemoryScopeAvailability(
		userPolicy,
		repositoryPolicyResult.value,
		new Set(SCOPES),
	);
	for (const scope of scopes) {
		const availability = policyAvailability.find(entry => entry.scope === scope);
		const reason = availability?.reason;
		if (!availability?.available)
			return fail(reason && reason !== "ok" ? reason : "policy_denied", `Scope ${scope} is unavailable.`);
	}
	for (const scope of scopes) {
		const root = roots.value.roots[scope];
		if (!root) return fail("identity_unavailable", `Scope ${scope} has no available root.`);
		const securedRoot =
			scope === "project"
				? await ensureFilesystemMemoryProjectDirectory(root)
				: await ensureFilesystemMemoryPrivateDirectory(root);
		if (securedRoot.code !== "ok") return securedRoot;
		const markerFile = path.join(root, MARKER);
		const existingMarker = await readInitializationMarker(root);
		if (existingMarker.code !== "ok") return existingMarker;
		if (!existingMarker.value) {
			const marker: FilesystemMemoryInitializationMarkerV1 = {
				version: 1,
				initializedAt: new Date().toISOString(),
				scopes: [scope],
			};
			const written = await writeIfMissing(markerFile, json(marker), scope !== "project");
			if (written.code !== "ok") return written;
		}
		const map: FilesystemMemoryMapV1 = { version: 1, routes: {} };
		for (const [name, contents] of [
			["memory.yaml", json(map)],
			["MEMORY.md", "# Memory\n\n"],
		] as const) {
			const written = await writeIfMissing(path.join(root, name), contents, scope !== "project");
			if (written.code !== "ok") return written;
		}
	}
	if (scopes.includes("global")) {
		const policy: FilesystemMemoryUserPolicyV1 = { version: 1, allowedScopes: SCOPES };
		const saved = await writeIfMissing(path.join(data, POLICY), json(policy), true);
		if (saved.code !== "ok") return saved;
	}
	return getFilesystemMemoryRoots(cwd, agentDir);
}

export async function checkpointFilesystemMemory(
	input: FilesystemMemoryCheckpointInput,
	cwd: string = process.cwd(),
	agentDir: string = getAgentDir(),
): Promise<FilesystemMemoryOutcome<FilesystemMemoryCheckpointResult>> {
	const taskId = canonicalId(input.taskId),
		sessionId = canonicalId(input.sessionId);
	if (!taskId || !sessionId || Buffer.byteLength(input.content) > MAX_CHECKPOINT_BYTES)
		return fail("invalid_path", "Checkpoint task, session, or content is invalid.");
	const roots = await getFilesystemMemoryRoots(cwd, agentDir);
	if (roots.code !== "ok") return roots;
	const root = roots.value.roots.session;
	if (!root) return unavailableScope(roots.value, "session");
	const directory = path.join(root, sessionId);
	const secured = await ensureFilesystemMemoryPrivateDirectory(directory);
	if (secured.code !== "ok") return secured;
	const file = path.join(directory, `${taskId}.checkpoint.json`);
	const body: FilesystemMemoryCheckpointV1 = {
		version: 1,
		taskId,
		createdAt: new Date().toISOString(),
		content: input.content,
		expectedDigest: input.expectedDigest ?? null,
	};
	const lock = await acquireLock(directory);
	if (lock.code !== "ok") return lock;
	try {
		const previous = await readSafeFilesystemMemoryFile(
			root,
			[sessionId, `${taskId}.checkpoint.json`],
			MAX_CHECKPOINT_BYTES,
		);
		if (previous.code === "ok") {
			let previousText: string;
			try {
				previousText = new TextDecoder("utf-8", { fatal: true }).decode(previous.value.bytes);
			} catch {
				return fail("invalid_path", "Checkpoint is not valid UTF-8.");
			}
			if (input.expectedDigest !== digest(previousText))
				return fail("topology_changed", "Checkpoint digest conflict.");
		} else if (previous.code === "not_found") {
			if (input.expectedDigest) return fail("topology_changed", "Checkpoint digest conflict.");
		} else {
			return previous;
		}
		const serialized = json(body);
		const saved = await atomicWriteUnlocked(file, serialized);
		if (saved.code !== "ok") return saved;
		const uri = formatFilesystemMemoryUri("session", [sessionId, `${taskId}.checkpoint.json`]);
		if (uri.code !== "ok") return uri;
		return { code: "ok", value: { uri: uri.value.canonical, digest: digest(serialized), checkpoint: body } };
	} finally {
		await releaseLock(directory, lock.value);
	}
}

export async function resumeFilesystemMemory(
	task: string,
	cwd: string = process.cwd(),
	agentDir: string = getAgentDir(),
): Promise<FilesystemMemoryOutcome<FilesystemMemoryResumeResult>> {
	const taskId = canonicalId(task);
	if (!taskId) return fail("invalid_path", "Task identifier is invalid.");
	const roots = await getFilesystemMemoryRoots(cwd, agentDir);
	if (roots.code !== "ok") return roots;
	const root = roots.value.roots.session;
	if (!root) return unavailableScope(roots.value, "session");
	const listed = await listSafeFilesystemMemoryDirectory(root, [], FILESYSTEM_MEMORY_MAX_INSPECTED_ENTRIES);
	if (listed.code !== "ok")
		return listed.code === "not_found" ? fail("not_found", "No session checkpoints are available.") : listed;
	const sessions = listed.value.entries
		.filter(entry => entry.type === "directory" && ID.test(entry.name))
		.map(entry => entry.name)
		.slice(0, MAX_CHECKPOINTS);
	const candidates: Array<{ session: string; raw: string; checkpoint: FilesystemMemoryCheckpointV1 }> = [];
	for (const session of sessions) {
		const read = await readSafeFilesystemMemoryFile(
			root,
			[session, `${taskId}.checkpoint.json`],
			MAX_CHECKPOINT_BYTES,
		);
		if (read.code !== "ok") {
			if (read.code === "not_found") continue;
			return read;
		}
		try {
			const raw = new TextDecoder("utf-8", { fatal: true }).decode(read.value.bytes);
			const checkpoint = JSON.parse(raw) as FilesystemMemoryCheckpointV1;
			if (
				checkpoint.version === 1 &&
				checkpoint.taskId === taskId &&
				typeof checkpoint.createdAt === "string" &&
				typeof checkpoint.content === "string"
			)
				candidates.push({ session, raw, checkpoint });
		} catch {
			/* malformed checkpoints are ignored during bounded recovery */
		}
	}
	if (!candidates.length) return fail("not_found", "No checkpoint matches this task.");
	candidates.sort(
		(a, b) => b.checkpoint.createdAt.localeCompare(a.checkpoint.createdAt) || b.session.localeCompare(a.session),
	);
	const selected = candidates[0];
	const uri = formatFilesystemMemoryUri("session", [selected.session, `${taskId}.checkpoint.json`]);
	if (uri.code !== "ok") return uri;
	return {
		code: "ok",
		value: {
			uri: uri.value.canonical,
			digest: digest(selected.raw),
			checkpoint: selected.checkpoint,
			verificationRequired: true,
		},
	};
}
