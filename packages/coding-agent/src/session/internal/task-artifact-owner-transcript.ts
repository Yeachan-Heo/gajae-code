import * as fs from "node:fs";
import * as path from "node:path";
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

/**
 * Read-only inventory of every authenticated managed cwd directory under one profile's
 * sessions root. Any incomplete, replaced, or unrecognized inventory conservatively
 * blocks owner retirement.
 */
export function hasSiblingTaskArtifactOwnerTranscript(
	storage: Pick<FileSessionStorage, "readSnapshotSync">,
	transcriptPath: string,
	locator: TaskArtifactOwnerLocator,
	context: TaskArtifactOwnerStorageContext,
): boolean {
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
	let rootBefore: fs.BigIntStats;
	try {
		assertManagedDirectoryRoot(authorityRoot);
		for (let parent = root; parent !== authorityRoot.canonicalPath; parent = path.dirname(parent)) {
			const stat = fs.lstatSync(parent, { bigint: true });
			if (!stat.isDirectory() || stat.isSymbolicLink()) return true;
		}
		rootBefore = fs.lstatSync(root, { bigint: true });
		if (!rootBefore.isDirectory() || rootBefore.isSymbolicLink()) return true;
		const entries = fs.readdirSync(root, { withFileTypes: true });
		if (entries.length > MAX_TRANSCRIPTS) return true;
		let scopeCount = 0;
		let totalManagedEntries = entries.length;
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
			const names = fs.readdirSync(pathname);
			totalManagedEntries += names.length;
			if (totalManagedEntries > MAX_TRANSCRIPTS) return true;
			recoveryBudget.entries = totalManagedEntries;
			directorySnapshots.push({ pathname, stat, names });
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
		const currentRoot = fs.lstatSync(root, { bigint: true });
		if (!sameDirectoryIdentity(currentRoot, rootBefore)) return true;
		for (const candidate of directorySnapshots) {
			const current = fs.lstatSync(candidate.pathname, { bigint: true });
			if (!sameDirectoryIdentity(current, candidate.stat)) return true;
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
