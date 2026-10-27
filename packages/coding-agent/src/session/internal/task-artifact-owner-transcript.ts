import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as util from "node:util";
import type * as natives from "@gajae-code/natives";
import type { FileSessionStorage, SessionStorageSnapshot } from "../session-storage";
import { parseFirstJsonlLine } from "../session-transcript-header";
import {
	OWNER_DIRECTORY,
	OWNER_LOCK_DIRECTORY,
	parseTaskArtifactOwnerLocator,
	type TaskArtifactOwnerLocator,
	type TaskArtifactOwnerStorageContext,
} from "../task-artifact-owner-codec";
import type {
	ManagedGcProtocolFileSnapshot,
	ManagedGcProtocolScopeInput,
	ManagedGcProtocolScopeInspector,
	ManagedGcProtocolScopeSnapshot,
} from "./managed-session-scope";
import {
	assertManagedDirectoryRoot,
	type ManagedDirectoryRoot,
	validateNativeSecurityResult,
} from "./managed-session-storage";
import { isDerivedSessionMemoryFile } from "./session-memory-sidecar";

type NativeScopeSecurity = Pick<typeof natives, "verifyOwnerOnlyPathSecurity" | "verifyOwnerOnlyPathSecurityExpected">;

let nativeScopeSecurityBindings: NativeScopeSecurity | undefined;

function nativeScopeSecurity(): NativeScopeSecurity {
	if (!nativeScopeSecurityBindings)
		nativeScopeSecurityBindings = require("@gajae-code/natives") as NativeScopeSecurity;
	return nativeScopeSecurityBindings;
}

const MAX_SCOPE_DIRECTORIES = 50_000;
const MAX_TRANSCRIPTS = 50_000;
const MANAGED_SCOPE_BINDING = ".gjc-managed-session-scope.v2.json";
const MANAGED_PROTOCOL_DIRECTORY = ".gjc-managed-session-internal";
const MANAGED_PROTOCOL_ROLES = ["locks", "receipts", "tombstones"] as const;
const transcriptDecoder = new TextDecoder("utf-8", { fatal: true });

function sameDirectoryIdentity(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
	return (
		left.isDirectory() &&
		!left.isSymbolicLink() &&
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.mtimeNs === right.mtimeNs &&
		left.ctimeNs === right.ctimeNs
	);
}

function sameFileSnapshot(snapshot: SessionStorageSnapshot, stat: fs.BigIntStats): boolean {
	return (
		snapshot.stat.isFile &&
		snapshot.stat.dev === stat.dev &&
		snapshot.stat.ino === stat.ino &&
		snapshot.stat.nlink === stat.nlink &&
		snapshot.stat.size === Number(stat.size) &&
		snapshot.stat.mtimeNs === stat.mtimeNs &&
		snapshot.stat.ctimeNs === stat.ctimeNs
	);
}

function verifyManagedDirectory(pathname: string, root: ManagedDirectoryRoot, stat: fs.BigIntStats): boolean {
	if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
	try {
		const native = nativeScopeSecurity();
		const security =
			process.platform === "win32"
				? native.verifyOwnerOnlyPathSecurityExpected(pathname, "directory", stat.dev, stat.ino)
				: native.verifyOwnerOnlyPathSecurity(pathname, "directory");
		if (!validateNativeSecurityResult(security, "verify", "directory").ok) return false;
		assertManagedDirectoryRoot(root);
		const current = fs.lstatSync(pathname, { bigint: true });
		return sameDirectoryIdentity(current, stat);
	} catch {
		return false;
	}
}

function verifyManagedFile(pathname: string, root: ManagedDirectoryRoot, stat: fs.BigIntStats): boolean {
	if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) return false;
	try {
		const native = nativeScopeSecurity();
		const security =
			process.platform === "win32"
				? native.verifyOwnerOnlyPathSecurityExpected(pathname, "file", stat.dev, stat.ino)
				: native.verifyOwnerOnlyPathSecurity(pathname, "file");
		if (!validateNativeSecurityResult(security, "verify", "file").ok) return false;
		assertManagedDirectoryRoot(root);
		const current = fs.lstatSync(pathname, { bigint: true });
		return (
			current.isFile() &&
			!current.isSymbolicLink() &&
			current.dev === stat.dev &&
			current.ino === stat.ino &&
			current.nlink === stat.nlink &&
			current.size === stat.size &&
			current.mtimeNs === stat.mtimeNs &&
			current.ctimeNs === stat.ctimeNs &&
			current.mode === stat.mode
		);
	} catch {
		return false;
	}
}

function inventoryRecoveryTree(
	pathname: string,
	root: ManagedDirectoryRoot,
	depth: number,
	directories: Array<{ pathname: string; stat: fs.BigIntStats; names: string[] }>,
	transcripts: string[],
	budget: { entries: number },
): boolean {
	if (depth > 32) return false;
	try {
		const stat = fs.lstatSync(pathname, { bigint: true });
		if (!verifyManagedDirectory(pathname, root, stat)) return false;
		const names = fs.readdirSync(pathname);
		budget.entries += names.length;
		if (budget.entries > MAX_TRANSCRIPTS) return false;
		directories.push({ pathname, stat, names });
		for (const name of names) {
			const child = path.join(pathname, name);
			const childStat = fs.lstatSync(child, { bigint: true });
			if (childStat.isSymbolicLink()) return false;
			if (childStat.isDirectory()) {
				if (!inventoryRecoveryTree(child, root, depth + 1, directories, transcripts, budget)) return false;
			} else if (childStat.isFile()) {
				if (name.endsWith(".jsonl") || name.includes(".jsonl.")) transcripts.push(child);
			} else return false;
		}
		return true;
	} catch {
		return false;
	}
}

function parseV2ScopeBinding(
	storage: Pick<FileSessionStorage, "readSnapshotSync">,
	directory: string,
	name: string,
): boolean {
	const bindingPath = path.join(directory, ".gjc-managed-session-scope.v2.json");
	try {
		const before = fs.lstatSync(bindingPath, { bigint: true });
		if (!before.isFile() || before.isSymbolicLink()) return false;
		const snapshot = storage.readSnapshotSync(bindingPath);
		const after = fs.lstatSync(bindingPath, { bigint: true });
		if (!sameFileSnapshot(snapshot, before) || !sameFileSnapshot(snapshot, after)) return false;
		const value: unknown = JSON.parse(Buffer.from(snapshot.bytes).toString("utf8"));
		if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
		const binding = value as Record<string, unknown>;
		const keys = ["schemaVersion", "layoutVersion", "identityVersion", "platform", "canonicalPath", "identityDigest"];
		if (
			Object.keys(binding).length !== keys.length ||
			!keys.every(key => Object.hasOwn(binding, key)) ||
			binding.schemaVersion !== 1 ||
			binding.layoutVersion !== 2 ||
			binding.identityVersion !== 1 ||
			(binding.platform !== "posix" && binding.platform !== "win32") ||
			typeof binding.canonicalPath !== "string" ||
			!path.isAbsolute(binding.canonicalPath) ||
			typeof binding.identityDigest !== "string" ||
			binding.identityDigest !== name.slice("v2-".length) ||
			!/^[a-z2-7]{52}$/u.test(binding.identityDigest)
		)
			return false;
		const canonical = `${JSON.stringify({
			schemaVersion: binding.schemaVersion,
			layoutVersion: binding.layoutVersion,
			identityVersion: binding.identityVersion,
			platform: binding.platform,
			canonicalPath: binding.canonicalPath,
			identityDigest: binding.identityDigest,
		})}\n`;
		return Buffer.from(snapshot.bytes).toString("utf8") === canonical;
	} catch {
		return false;
	}
}

/** Resolve the path-free owner locator using transcript replay's header-patch semantics. */
export function taskArtifactOwnerLocatorFromTranscriptBytes(
	bytes: Uint8Array,
	expectedSessionId: string,
): TaskArtifactOwnerLocator | undefined {
	const header = parseFirstJsonlLine(bytes);
	if (header?.type !== "session" || header.id !== expectedSessionId)
		throw new Error("task_artifact_owner_transcript_header_invalid");
	let locator = parseTaskArtifactOwnerLocator(header.taskArtifactOwner);
	if (typeof header.version !== "number" || header.version < 4) return locator;
	const firstEnd = bytes.indexOf(0x0a);
	let start = firstEnd < 0 ? bytes.byteLength : firstEnd + 1;
	while (start < bytes.byteLength) {
		const newline = bytes.indexOf(0x0a, start);
		const end = newline < 0 ? bytes.byteLength : newline;
		const line = bytes.subarray(start, end);
		let record: Record<string, unknown> | undefined;
		try {
			if (line.byteLength > 0) {
				const parsed: unknown = JSON.parse(transcriptDecoder.decode(line));
				if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed))
					record = parsed as Record<string, unknown>;
			}
		} catch {
			const text = Buffer.from(line).toString("utf8");
			if (text.includes("header_patch") && text.includes("taskArtifactOwner"))
				throw new Error("task_artifact_owner_patch_invalid");
		}
		if (
			record?.type === "header_patch" &&
			typeof record.patch === "object" &&
			record.patch !== null &&
			!Array.isArray(record.patch) &&
			Object.hasOwn(record.patch, "taskArtifactOwner")
		) {
			const patch = record.patch as Record<string, unknown>;
			if (
				!Object.keys(record).every(key => key === "type" || key === "patch") ||
				!Object.keys(patch).every(
					key =>
						key === "cwd" ||
						key === "title" ||
						key === "titleSource" ||
						key === "starred" ||
						key === "taskArtifactOwner",
				) ||
				(patch.cwd !== undefined && typeof patch.cwd !== "string") ||
				(patch.title !== undefined && typeof patch.title !== "string") ||
				(patch.titleSource !== undefined && patch.titleSource !== "auto" && patch.titleSource !== "user") ||
				(patch.starred !== undefined && typeof patch.starred !== "boolean")
			)
				throw new Error("task_artifact_owner_patch_invalid");
			try {
				locator = parseTaskArtifactOwnerLocator(patch.taskArtifactOwner);
			} catch {
				throw new Error("task_artifact_owner_patch_invalid");
			}
		}
		if (newline < 0) break;
		start = newline + 1;
	}
	return locator;
}

function protocolFileIdentity(
	storage: Pick<FileSessionStorage, "readSnapshotSync">,
	pathname: string,
	root: ManagedDirectoryRoot,
): { readonly identity: ManagedGcProtocolFileSnapshot } | undefined {
	try {
		const before = fs.lstatSync(pathname, { bigint: true });
		if (!verifyManagedFile(pathname, root, before)) return undefined;
		const snapshot = storage.readSnapshotSync(pathname);
		const after = fs.lstatSync(pathname, { bigint: true });
		if (
			!verifyManagedFile(pathname, root, after) ||
			!sameFileSnapshot(snapshot, before) ||
			!sameFileSnapshot(snapshot, after) ||
			before.mode !== after.mode
		)
			return undefined;
		return {
			identity: {
				name: path.basename(pathname),
				dev: snapshot.stat.dev.toString(),
				ino: snapshot.stat.ino.toString(),
				nlink: snapshot.stat.nlink!.toString(),
				size: snapshot.stat.size,
				mtimeNs: snapshot.stat.mtimeNs.toString(),
				ctimeNs: snapshot.stat.ctimeNs.toString(),
				mode: Number(before.mode & 0o777n),
				sha256: createHash("sha256").update(snapshot.bytes).digest("hex"),
			},
		};
	} catch {
		return undefined;
	}
}

/**
 * Read-only inventory of every authenticated managed cwd directory under one profile's
 * sessions root. Any incomplete, replaced, or unrecognized inventory conservatively
 * blocks owner retirement.
 */
export async function hasSiblingTaskArtifactOwnerTranscript(
	storage: Pick<FileSessionStorage, "readSnapshotSync">,
	transcriptPath: string,
	locator: TaskArtifactOwnerLocator,
	context: TaskArtifactOwnerStorageContext,
	inspectProtocol?: ManagedGcProtocolScopeInspector,
): Promise<boolean> {
	const root = path.resolve(context.sessionsRoot);
	const authorityRoot = context.rootAuthority;
	if (
		root !== context.sessionsRoot ||
		!pathIsWithin(authorityRoot.canonicalPath, root) ||
		path.resolve(context.profileAgentDir) !== context.profileAgentDir
	)
		return true;
	const directorySnapshots: Array<{ pathname: string; stat: fs.BigIntStats; names: string[] }> = [];
	const directTranscripts: string[] = [];
	const protocolObservations: {
		input: ManagedGcProtocolScopeInput;
		scopeStat: fs.BigIntStats;
		scopeNames: string[];
		bindingIdentity: ManagedGcProtocolFileSnapshot;
		protocolStat: fs.BigIntStats;
		protocolNames: string[];
		roleDirectories: { pathname: string; stat: fs.BigIntStats; names: string[] }[];
	}[] = [];
	let totalManagedEntries = 0;
	let rootBefore: fs.BigIntStats;
	let rootNames: string[];
	let verifiedProtocolSnapshots: readonly ManagedGcProtocolScopeSnapshot[] = [];
	let profileBefore: fs.BigIntStats;
	try {
		assertManagedDirectoryRoot(authorityRoot);
		for (let parent = root; parent !== authorityRoot.canonicalPath; parent = path.dirname(parent)) {
			const stat = fs.lstatSync(parent, { bigint: true });
			if (!stat.isDirectory() || stat.isSymbolicLink()) return true;
		}
		rootBefore = fs.lstatSync(root, { bigint: true });
		profileBefore = fs.lstatSync(context.profileAgentDir, { bigint: true });
		if (
			!verifyManagedDirectory(context.profileAgentDir, authorityRoot, profileBefore) ||
			!verifyManagedDirectory(root, authorityRoot, rootBefore)
		)
			return true;
		if (!rootBefore.isDirectory() || rootBefore.isSymbolicLink()) return true;
		const entries = fs.readdirSync(root, { withFileTypes: true });
		rootNames = entries.map(entry => entry.name).sort();
		if (entries.length > MAX_TRANSCRIPTS) return true;
		let scopeCount = 0;
		totalManagedEntries = entries.length;
		const recoveryBudget = { entries: totalManagedEntries };
		for (const entry of entries) {
			const pathname = path.join(root, entry.name);
			if (entry.isFile() && (entry.name.endsWith(".jsonl") || entry.name.includes(".jsonl."))) {
				directTranscripts.push(pathname);
				continue;
			}
			if (!entry.isDirectory()) {
				if (entry.isSymbolicLink()) return true;
				continue;
			}
			if ([OWNER_DIRECTORY, OWNER_LOCK_DIRECTORY].includes(entry.name)) continue;
			if (entry.name === ".gjc-recovery") {
				if (
					!inventoryRecoveryTree(pathname, authorityRoot, 0, directorySnapshots, directTranscripts, recoveryBudget)
				)
					return true;
				totalManagedEntries = recoveryBudget.entries;
				continue;
			}
			if (!entry.name.startsWith("v2-") && !entry.name.startsWith("-")) return true;
			if (++scopeCount > MAX_SCOPE_DIRECTORIES) return true;
			if (entry.name.startsWith("v2-") && !/^v2-[a-z2-7]{52}$/u.test(entry.name)) return true;
			const stat = fs.lstatSync(pathname, { bigint: true });
			if (!verifyManagedDirectory(pathname, authorityRoot, stat)) return true;
			if (entry.name.startsWith("v2-") && !parseV2ScopeBinding(storage, pathname, entry.name)) return true;
			const names = fs.readdirSync(pathname).sort();
			if (names.some(name => name.startsWith(MANAGED_PROTOCOL_DIRECTORY) && name !== MANAGED_PROTOCOL_DIRECTORY))
				return true;
			totalManagedEntries += names.length;
			if (totalManagedEntries > MAX_TRANSCRIPTS) return true;
			recoveryBudget.entries = totalManagedEntries;
			directorySnapshots.push({ pathname, stat, names });
			const protocolNameIndex = names.indexOf(MANAGED_PROTOCOL_DIRECTORY);
			if (protocolNameIndex >= 0) {
				if (!entry.name.startsWith("v2-") || !inspectProtocol) return true;
				const protocolPath = path.join(pathname, MANAGED_PROTOCOL_DIRECTORY);
				const protocolStat = fs.lstatSync(protocolPath, { bigint: true });
				if (!verifyManagedDirectory(protocolPath, authorityRoot, protocolStat)) return true;
				const protocolNames = fs.readdirSync(protocolPath).sort();
				if (protocolNames.join("\0") !== MANAGED_PROTOCOL_ROLES.join("\0")) return true;
				const roleDirectories: { pathname: string; stat: fs.BigIntStats; names: string[] }[] = [];
				for (const role of MANAGED_PROTOCOL_ROLES) {
					const rolePath = path.join(protocolPath, role);
					const roleStat = fs.lstatSync(rolePath, { bigint: true });
					if (!verifyManagedDirectory(rolePath, authorityRoot, roleStat)) return true;
					const roleNames = fs.readdirSync(rolePath).sort();
					roleDirectories.push({ pathname: rolePath, stat: roleStat, names: roleNames });
					totalManagedEntries += 1 + roleNames.length;
				}
				if (totalManagedEntries > MAX_TRANSCRIPTS) return true;
				recoveryBudget.entries = totalManagedEntries;
				const bindingPath = path.join(pathname, MANAGED_SCOPE_BINDING);
				const binding = protocolFileIdentity(storage, bindingPath, authorityRoot);
				if (!binding) return true;
				const input: ManagedGcProtocolScopeInput = {
					scopePath: pathname,
					scopeIdentity: { path: pathname, dev: stat.dev.toString(), ino: stat.ino.toString() },
					bindingIdentity: binding.identity,
					protocolIdentity: {
						path: protocolPath,
						dev: protocolStat.dev.toString(),
						ino: protocolStat.ino.toString(),
						mtimeNs: protocolStat.mtimeNs.toString(),
						ctimeNs: protocolStat.ctimeNs.toString(),
						mode: Number(protocolStat.mode & 0o777n),
					},
				};
				protocolObservations.push({
					input,
					scopeStat: stat,
					scopeNames: names,
					bindingIdentity: binding.identity,
					protocolStat,
					protocolNames,
					roleDirectories,
				});
				directorySnapshots.push({ pathname: protocolPath, stat: protocolStat, names: protocolNames });
				directorySnapshots.push(...roleDirectories);
			}
			const stagingPath = path.join(pathname, ".staging");
			let stagingStat: fs.BigIntStats | undefined;
			try {
				stagingStat = fs.lstatSync(stagingPath, { bigint: true });
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") return true;
			}
			if (stagingStat) {
				if (!verifyManagedDirectory(stagingPath, authorityRoot, stagingStat)) return true;
				const stagedNames = fs.readdirSync(stagingPath);
				totalManagedEntries += stagedNames.length;
				if (totalManagedEntries > MAX_TRANSCRIPTS) return true;
				recoveryBudget.entries = totalManagedEntries;
				directorySnapshots.push({ pathname: stagingPath, stat: stagingStat, names: stagedNames });
			}
		}
	} catch {
		return true;
	}

	if (protocolObservations.length > 0) {
		try {
			const protocolSnapshots = await inspectProtocol!(protocolObservations.map(observation => observation.input));
			if (protocolSnapshots.length !== protocolObservations.length) return true;
			for (let index = 0; index < protocolObservations.length; index++) {
				const observation = protocolObservations[index]!;
				const snapshot = protocolSnapshots[index]!;
				const { input } = observation;
				const identityMatches = (
					actual: { readonly path: string; readonly dev: string; readonly ino: string },
					pathname: string,
					stat: fs.BigIntStats,
				): boolean =>
					actual.path === pathname && actual.dev === stat.dev.toString() && actual.ino === stat.ino.toString();
				const configuredRootStat = fs.lstatSync(authorityRoot.canonicalPath, { bigint: true });
				if (
					!identityMatches(snapshot.configuredRoot, authorityRoot.canonicalPath, configuredRootStat) ||
					!identityMatches(snapshot.profile, context.profileAgentDir, profileBefore) ||
					!identityMatches(snapshot.sessionsRoot, root, rootBefore) ||
					!identityMatches(snapshot.scope, input.scopePath, observation.scopeStat) ||
					!identityMatches(snapshot.protocol, input.protocolIdentity.path, observation.protocolStat) ||
					!util.isDeepStrictEqual(snapshot.binding, observation.bindingIdentity) ||
					snapshot.protocolMtimeNs !== observation.protocolStat.mtimeNs.toString() ||
					snapshot.protocolCtimeNs !== observation.protocolStat.ctimeNs.toString() ||
					snapshot.protocolMode !== Number(observation.protocolStat.mode & 0o777n) ||
					snapshot.directories.length !== MANAGED_PROTOCOL_ROLES.length ||
					MANAGED_PROTOCOL_ROLES.some((role, roleIndex) => snapshot.directories[roleIndex]?.role !== role)
				)
					return true;
				const scopeNow = fs.lstatSync(input.scopePath, { bigint: true });
				if (
					!verifyManagedDirectory(input.scopePath, authorityRoot, scopeNow) ||
					!sameDirectoryIdentity(scopeNow, observation.scopeStat) ||
					fs.readdirSync(input.scopePath).sort().join("\0") !== observation.scopeNames.join("\0")
				)
					return true;
				const bindingNow = protocolFileIdentity(
					storage,
					path.join(input.scopePath, MANAGED_SCOPE_BINDING),
					authorityRoot,
				);
				if (!bindingNow || !util.isDeepStrictEqual(bindingNow.identity, input.bindingIdentity)) return true;
				const protocolNow = fs.lstatSync(input.protocolIdentity.path, { bigint: true });
				if (
					!verifyManagedDirectory(input.protocolIdentity.path, authorityRoot, protocolNow) ||
					!sameDirectoryIdentity(protocolNow, observation.protocolStat) ||
					protocolNow.mode !== observation.protocolStat.mode ||
					fs.readdirSync(input.protocolIdentity.path).sort().join("\0") !== observation.protocolNames.join("\0") ||
					observation.protocolNames.join("\0") !== MANAGED_PROTOCOL_ROLES.join("\0")
				)
					return true;
				for (const directory of snapshot.directories) {
					const rolePath = path.join(input.protocolIdentity.path, directory.role);
					const roleObservation = observation.roleDirectories[MANAGED_PROTOCOL_ROLES.indexOf(directory.role)];
					const roleStat = fs.lstatSync(rolePath, { bigint: true });
					const roleNames = fs.readdirSync(rolePath).sort();
					if (
						directory.path !== rolePath ||
						!roleObservation ||
						!verifyManagedDirectory(rolePath, authorityRoot, roleStat) ||
						!sameDirectoryIdentity(roleStat, roleObservation.stat) ||
						roleStat.mode !== roleObservation.stat.mode ||
						roleNames.join("\0") !== roleObservation.names.join("\0") ||
						roleStat.dev.toString() !== directory.dev ||
						roleStat.ino.toString() !== directory.ino ||
						roleStat.mtimeNs.toString() !== directory.mtimeNs ||
						roleStat.ctimeNs.toString() !== directory.ctimeNs ||
						Number(roleStat.mode & 0o777n) !== directory.mode ||
						roleNames.length !== directory.files.length ||
						roleNames.join("\0") !== directory.files.map(file => file.name).join("\0")
					)
						return true;
					for (const expected of directory.files) {
						const current = protocolFileIdentity(storage, path.join(rolePath, expected.name), authorityRoot);
						if (!current || !util.isDeepStrictEqual(current.identity, expected)) return true;
					}
				}
				if (totalManagedEntries > MAX_TRANSCRIPTS) return true;
			}
			verifiedProtocolSnapshots = protocolSnapshots;
		} catch {
			return true;
		}
	}

	const candidatePaths = new Set(
		directTranscripts.filter(pathname => !pathname.includes(".jsonl.") || !isDerivedSessionMemoryFile(pathname)),
	);
	for (const directory of directorySnapshots) {
		for (const name of directory.names) {
			if (
				name.endsWith(".jsonl") ||
				(name.includes(".jsonl.") && !isDerivedSessionMemoryFile(path.join(directory.pathname, name)))
			)
				candidatePaths.add(path.join(directory.pathname, name));
		}
	}
	if (candidatePaths.size > MAX_TRANSCRIPTS) return true;
	for (const siblingPath of candidatePaths) {
		if (path.resolve(siblingPath) === path.resolve(transcriptPath)) continue;
		try {
			const before = fs.lstatSync(siblingPath, { bigint: true });
			if (before.isSymbolicLink() || !before.isFile()) return true;
			const sibling = storage.readSnapshotSync(siblingPath);
			const after = fs.lstatSync(siblingPath, { bigint: true });
			if (
				after.isSymbolicLink() ||
				!after.isFile() ||
				after.dev !== before.dev ||
				after.ino !== before.ino ||
				after.nlink !== before.nlink ||
				after.size !== before.size ||
				after.mtimeNs !== before.mtimeNs ||
				after.ctimeNs !== before.ctimeNs ||
				!sameFileSnapshot(sibling, before)
			)
				return true;
			const header = parseFirstJsonlLine(sibling.bytes);
			if (header?.type !== "session" || typeof header.id !== "string") return true;
			const siblingLocator = taskArtifactOwnerLocatorFromTranscriptBytes(sibling.bytes, header.id);
			if (siblingLocator && JSON.stringify(siblingLocator) === JSON.stringify(locator)) return true;
		} catch {
			return true;
		}
	}
	try {
		assertManagedDirectoryRoot(authorityRoot);
		const currentProfile = fs.lstatSync(context.profileAgentDir, { bigint: true });
		const currentRoot = fs.lstatSync(root, { bigint: true });
		if (
			!verifyManagedDirectory(context.profileAgentDir, authorityRoot, currentProfile) ||
			!sameDirectoryIdentity(currentProfile, profileBefore) ||
			!verifyManagedDirectory(root, authorityRoot, currentRoot) ||
			!sameDirectoryIdentity(currentRoot, rootBefore) ||
			fs.readdirSync(root).sort().join("\0") !== rootNames.join("\0")
		)
			return true;
		for (const candidate of directorySnapshots) {
			const current = fs.lstatSync(candidate.pathname, { bigint: true });
			if (
				!verifyManagedDirectory(candidate.pathname, authorityRoot, current) ||
				!sameDirectoryIdentity(current, candidate.stat) ||
				current.mode !== candidate.stat.mode ||
				fs.readdirSync(candidate.pathname).sort().join("\0") !== candidate.names.join("\0")
			)
				return true;
		}
		for (const observation of protocolObservations) {
			const binding = protocolFileIdentity(
				storage,
				path.join(observation.input.scopePath, MANAGED_SCOPE_BINDING),
				authorityRoot,
			);
			if (!binding || !util.isDeepStrictEqual(binding.identity, observation.bindingIdentity)) return true;
		}
		for (const snapshot of verifiedProtocolSnapshots) {
			for (const directory of snapshot.directories) {
				for (const expected of directory.files) {
					const current = protocolFileIdentity(storage, path.join(directory.path, expected.name), authorityRoot);
					if (!current || !util.isDeepStrictEqual(current.identity, expected)) return true;
				}
			}
		}
	} catch {
		return true;
	}
	return false;
}

function pathIsWithin(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}
