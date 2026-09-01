/**
 * Coordinator directory scans that must not treat native exact-unlink debris
 * as live JSON, and must not make start/status unreadable on a large dirent pile.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

class ProjectionScanRaceError extends Error {
	readonly code = "PROJECTION_SCAN_RACED";

	constructor(message: string) {
		super(message);
		this.name = "ProjectionScanRaceError";
	}
}

const PROJECTION_SCAN_UNSUPPORTED_CODE = "coordinator_projection_safe_read_unsupported";

class ProjectionScanUnsupportedError extends Error {
	readonly code = PROJECTION_SCAN_UNSUPPORTED_CODE;

	constructor() {
		super(PROJECTION_SCAN_UNSUPPORTED_CODE);
		this.name = "ProjectionScanUnsupportedError";
	}
}

/** Test-only platform seam; production always follows the host platform. */
export const ProjectionScanTestHooks: {
	platform?: NodeJS.Platform;
} = {};

function projectionPlatform(): NodeJS.Platform {
	return ProjectionScanTestHooks.platform ?? process.platform;
}

/** Post-filter parse-candidate cap. Exhaustion returns an explicit incomplete result. */
export const COORDINATOR_JSON_SCAN_CAP = 10_000;
/** Number of fresh authoritative attempts allowed for a scan that observed churn. */
export const COORDINATOR_JSON_SCAN_RETRY_ATTEMPTS = 3;

export interface ProjectionScanStat {
	size: number | bigint;
	dev?: number | bigint;
	ino?: number | bigint;
	nlink?: number | bigint;
	mtimeNs?: number | bigint;
	ctimeNs?: number | bigint;
	isDirectory?(): boolean;
	isFile(): boolean;
	isSymbolicLink(): boolean;
}

export interface ProjectionScanFs {
	readdir(dir: string): Promise<string[]>;
	lstat(file: string): Promise<ProjectionScanStat>;
	readFile(file: string, encoding: "utf8", expected?: ProjectionScanStat): Promise<string>;
	/** Optional descriptor-bound reader used by the production filesystem. */
	readFileSafe?: (file: string, encoding: "utf8", expected?: ProjectionScanStat) => Promise<string>;
	/** Optional pinned directory authority used for enumeration and every child operation. */
	openDirectory?: (dir: string) => Promise<ProjectionScanDirectory>;
}

export interface ProjectionScanDirectory {
	readonly stat: ProjectionScanStat;
	readdir(): Promise<string[]>;
	lstat(entry: string): Promise<ProjectionScanStat>;
	readFile(entry: string, encoding: "utf8", expected?: ProjectionScanStat): Promise<string>;
	close(): Promise<void>;
}

export interface ProjectionScanResult {
	values: unknown[];
	parsed: number;
	capped: boolean;
	skippedDebris: number;
	skippedEmpty: number;
	/** Candidates that changed or disappeared after enumeration. */
	raced: number;
	/** True when the scan cannot be authoritative for its caller. */
	incomplete: boolean;
}

/**
 * Read one discovered candidate without ever following a final-component symlink or
 * blocking on a FIFO. POSIX opens are descriptor-bound by O_NOFOLLOW/O_NONBLOCK. Windows
 * has neither flag, so the path is bracketed by lstat/fstat/lstat identity checks and the
 * bytes still come from the opened handle rather than the mutable pathname.
 */
function sameProjectionFile(left: ProjectionScanStat, right: ProjectionScanStat): boolean {
	if (!left.isFile() || !right.isFile()) return false;
	if (
		left.dev === undefined ||
		right.dev === undefined ||
		left.ino === undefined ||
		right.ino === undefined ||
		String(left.dev) !== String(right.dev) ||
		String(left.ino) !== String(right.ino) ||
		String(left.size) !== String(right.size)
	)
		return false;
	if (left.nlink !== undefined && right.nlink !== undefined && String(left.nlink) !== String(right.nlink))
		return false;
	if (left.mtimeNs !== undefined && right.mtimeNs !== undefined && String(left.mtimeNs) !== String(right.mtimeNs))
		return false;
	if (left.ctimeNs !== undefined && right.ctimeNs !== undefined && String(left.ctimeNs) !== String(right.ctimeNs))
		return false;
	return true;
}

async function readProjectionFileSafe(file: string, encoding: "utf8", expected?: ProjectionScanStat): Promise<string> {
	if (encoding !== "utf8") throw new TypeError("Coordinator projection reads require utf8.");
	const platform = projectionPlatform();
	const noFollow = fs.constants.O_NOFOLLOW;
	const nonBlock = fs.constants.O_NONBLOCK;
	if (platform !== "win32" && (typeof noFollow !== "number" || typeof nonBlock !== "number"))
		throw new ProjectionScanUnsupportedError();
	const flags = fs.constants.O_RDONLY | (platform === "win32" ? 0 : (nonBlock as number) | (noFollow as number));
	let before: import("node:fs").BigIntStats | undefined;
	if (platform === "win32") {
		before = await fs.lstat(file, { bigint: true });
		if (before.isSymbolicLink() || !before.isFile())
			throw new ProjectionScanRaceError("candidate is not a regular file");
	}
	let handle: fs.FileHandle | undefined;
	try {
		handle = await fs.open(file, flags);
		const opened = await handle.stat({ bigint: true });
		if (!opened.isFile()) throw new ProjectionScanRaceError("candidate changed to a non-regular file");
		if (expected && !sameProjectionFile(expected, opened))
			throw new ProjectionScanRaceError("candidate changed while opening");
		if (before) {
			if (
				before.dev !== opened.dev ||
				before.ino !== opened.ino ||
				before.nlink !== opened.nlink ||
				before.size !== opened.size ||
				before.mtimeNs !== opened.mtimeNs ||
				before.ctimeNs !== opened.ctimeNs
			)
				throw new ProjectionScanRaceError("candidate changed while opening");
			const relinked = await fs.lstat(file, { bigint: true });
			if (
				relinked.isSymbolicLink() ||
				!relinked.isFile() ||
				relinked.dev !== opened.dev ||
				relinked.ino !== opened.ino ||
				relinked.nlink !== opened.nlink ||
				relinked.size !== opened.size ||
				relinked.mtimeNs !== opened.mtimeNs ||
				relinked.ctimeNs !== opened.ctimeNs
			)
				throw new ProjectionScanRaceError("candidate changed before read");
		}
		return await handle.readFile({ encoding: "utf8" });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ELOOP")
			throw new ProjectionScanRaceError("candidate became a symlink");
		throw error;
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

function sameProjectionRoot(left: ProjectionScanStat, right: ProjectionScanStat): boolean {
	const leftDirectory = left.isDirectory?.();
	const rightDirectory = right.isDirectory?.();
	return (
		leftDirectory !== false &&
		rightDirectory !== false &&
		left.dev !== undefined &&
		right.dev !== undefined &&
		left.ino !== undefined &&
		right.ino !== undefined &&
		String(left.dev) === String(right.dev) &&
		String(left.ino) === String(right.ino)
	);
}

function hasProjectionRootIdentity(stat: ProjectionScanStat): boolean {
	return stat.dev !== undefined && stat.ino !== undefined;
}

function trimProjectionRootPath(dir: string): string {
	const parsedRoot = path.parse(dir).root;
	let trimmed = dir;
	while (trimmed.length > parsedRoot.length && (trimmed.endsWith("/") || trimmed.endsWith("\\")))
		trimmed = trimmed.slice(0, -1);
	while (trimmed.length > parsedRoot.length && (trimmed.endsWith("/.") || trimmed.endsWith("\\."))) {
		trimmed = trimmed.slice(0, -2);
		while (trimmed.length > parsedRoot.length && (trimmed.endsWith("/") || trimmed.endsWith("\\")))
			trimmed = trimmed.slice(0, -1);
	}
	return trimmed || parsedRoot;
}

/**
 * Windows has no descriptor-relative `openat` binding in Node. Keep the root pathname
 * authoritative by checking its identity before and after every mutable-path operation.
 */
async function openProjectionDirectoryWindowsSafe(dir: string): Promise<ProjectionScanDirectory> {
	const rootPath = trimProjectionRootPath(dir);
	let opened: import("node:fs").BigIntStats;
	try {
		opened = await fs.lstat(rootPath, { bigint: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ELOOP")
			throw new ProjectionScanRaceError("scan root became a reparse point");
		throw error;
	}
	if (opened.isSymbolicLink() || !opened.isDirectory())
		throw new ProjectionScanRaceError("scan root is not a regular directory");

	const assertRoot = async (): Promise<void> => {
		let settled: import("node:fs").BigIntStats;
		try {
			settled = await fs.lstat(rootPath, { bigint: true });
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT" || code === "ELOOP")
				throw new ProjectionScanRaceError("scan root changed during enumeration");
			throw error;
		}
		if (settled.isSymbolicLink() || !settled.isDirectory() || !sameProjectionRoot(opened, settled))
			throw new ProjectionScanRaceError("scan root changed during enumeration");
	};

	const entryPath = (entry: string): string => {
		// Directory entries come from readdir and are therefore single components on
		// Windows. Keep the invariant explicit so an injected or corrupted entry can
		// never turn a child operation into mutable pathname traversal.
		if (
			entry.length === 0 ||
			entry === "." ||
			entry === ".." ||
			entry.includes("/") ||
			entry.includes("\\") ||
			entry.includes(":")
		)
			throw new ProjectionScanRaceError("scan entry is not a single directory component");
		return path.join(rootPath, entry);
	};

	const bracketRoot = async <T>(operation: () => Promise<T>): Promise<T> => {
		let value!: T;
		let operationError: unknown;
		let started = false;
		try {
			await assertRoot();
			started = true;
			value = await operation();
		} catch (error) {
			operationError = error;
		}
		if (started) {
			try {
				await assertRoot();
			} catch (error) {
				operationError = error;
			}
		}
		if (operationError !== undefined) {
			const code = (operationError as NodeJS.ErrnoException).code;
			if (code === "ENOENT" || code === "ELOOP")
				throw new ProjectionScanRaceError("scan operation raced with a replacement or reparse point");
			throw operationError;
		}
		return value;
	};

	return {
		stat: opened,
		readdir: () => bracketRoot(() => fs.readdir(rootPath)),
		lstat: entry =>
			bracketRoot(async () => {
				const stat = await fs.lstat(entryPath(entry), { bigint: true });
				if (stat.isSymbolicLink()) throw new ProjectionScanRaceError("candidate became a reparse point");
				return stat;
			}),
		readFile: (entry, encoding, expected) =>
			bracketRoot(() => readProjectionFileSafe(entryPath(entry), encoding, expected)),
		close: async () => {},
	};
}

/**
 * Open a no-follow directory authority and keep it alive through enumeration, child
 * lstat, and child reads. Node has no `openat` binding, so POSIX uses the proc fd path
 * as the descriptor-relative namespace; a replacement root or parent cannot redirect it.
 */
async function openProjectionDirectorySafe(dir: string): Promise<ProjectionScanDirectory> {
	const platform = projectionPlatform();
	if (platform === "win32") return openProjectionDirectoryWindowsSafe(dir);
	if (platform !== "linux") throw new ProjectionScanUnsupportedError();
	const noFollow = fs.constants.O_NOFOLLOW;
	const nonBlock = fs.constants.O_NONBLOCK;
	if (typeof noFollow !== "number" || typeof nonBlock !== "number") throw new ProjectionScanUnsupportedError();
	const directoryFlag = typeof fs.constants.O_DIRECTORY === "number" ? fs.constants.O_DIRECTORY : 0;
	const flags = fs.constants.O_RDONLY | (nonBlock as number) | (noFollow as number) | directoryFlag;
	let handle: fs.FileHandle | undefined;
	try {
		handle = await fs.open(dir, flags);
		const opened = await handle.stat({ bigint: true });
		if (!opened.isDirectory()) throw new ProjectionScanRaceError("scan root is not a directory");
		const pinnedPath = `/proc/self/fd/${handle.fd}`;
		const ownedHandle = handle;
		handle = undefined;
		const assertRoot = async (): Promise<void> => {
			const settled = await ownedHandle.stat({ bigint: true });
			if (!sameProjectionRoot(opened, settled)) throw new ProjectionScanRaceError("scan root descriptor changed");
		};
		return {
			stat: opened,
			readdir: async () => {
				const entries = await fs.readdir(pinnedPath);
				await assertRoot();
				return entries;
			},
			lstat: async entry => {
				const stat = await fs.lstat(path.join(pinnedPath, entry), { bigint: true });
				await assertRoot();
				return stat;
			},
			readFile: async (entry, encoding, expected) => {
				const source = await readProjectionFileSafe(path.join(pinnedPath, entry), encoding, expected);
				await assertRoot();
				return source;
			},
			close: async () => {
				await ownedHandle.close().catch(() => undefined);
			},
		};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ELOOP")
			throw new ProjectionScanRaceError("scan root became a symlink");
		throw error;
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

const failUnpinnedProjectionOperation = async (): Promise<never> => {
	throw new ProjectionScanUnsupportedError();
};

const defaultFs: ProjectionScanFs = {
	// The default implementation never permits an accidental mutable-path fallback;
	// all production operations must go through openProjectionDirectorySafe above.
	readdir: failUnpinnedProjectionOperation,
	lstat: failUnpinnedProjectionOperation,
	readFile: failUnpinnedProjectionOperation,
	readFileSafe: failUnpinnedProjectionOperation,
	openDirectory: openProjectionDirectorySafe,
};

export function isCoordinatorScanDebrisName(name: string): boolean {
	return name.startsWith(".");
}

async function scanCoordinatorJsonFiles(
	dir: string,
	io: ProjectionScanFs = defaultFs,
	cap: number = COORDINATOR_JSON_SCAN_CAP,
	authority?: ProjectionScanDirectory,
): Promise<ProjectionScanResult> {
	let rootStat: ProjectionScanStat;
	try {
		rootStat = authority?.stat ?? (await io.lstat(dir));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return {
				values: [],
				parsed: 0,
				capped: false,
				skippedDebris: 0,
				skippedEmpty: 0,
				raced: 0,
				incomplete: false,
			};
		}
		throw error;
	}
	if (rootStat.isSymbolicLink() || rootStat.isDirectory?.() === false) {
		return {
			values: [],
			parsed: 0,
			capped: true,
			skippedDebris: 0,
			skippedEmpty: 0,
			raced: 1,
			incomplete: true,
		};
	}
	let entries: string[];
	try {
		entries = authority ? await authority.readdir() : await io.readdir(dir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return {
				values: [],
				parsed: 0,
				capped: true,
				skippedDebris: 0,
				skippedEmpty: 0,
				raced: 1,
				incomplete: true,
			};
		}
		if (error instanceof ProjectionScanRaceError) {
			return {
				values: [],
				parsed: 0,
				capped: true,
				skippedDebris: 0,
				skippedEmpty: 0,
				raced: 1,
				incomplete: true,
			};
		}
		throw error;
	}

	let skippedDebris = 0;
	let skippedEmpty = 0;
	let raced = 0;
	const parseCandidates: Array<{ entry: string; stat: ProjectionScanStat }> = [];
	for (const entry of entries) {
		if (!entry.endsWith(".json") || isCoordinatorScanDebrisName(entry)) {
			if (entry.endsWith(".json") && isCoordinatorScanDebrisName(entry)) skippedDebris += 1;
			continue;
		}
		const file = path.join(dir, entry);
		let stat: ProjectionScanStat;
		try {
			stat = authority ? await authority.lstat(entry) : await io.lstat(file);
		} catch (error) {
			if (
				(error as NodeJS.ErrnoException).code === "ENOENT" ||
				(error as NodeJS.ErrnoException).code === "ELOOP" ||
				error instanceof ProjectionScanRaceError
			) {
				raced += 1;
				continue;
			}
			throw error;
		}
		if (stat.isSymbolicLink() || !stat.isFile()) {
			// The candidate was a parseable-looking directory entry when enumeration
			// completed, but its type changed before inspection. Treat that as a
			// raced candidate rather than ordinary empty/non-regular debris: callers
			// must not consume a partial projection set.
			raced += 1;
			continue;
		}
		parseCandidates.push({ entry, stat });
	}

	const capped = parseCandidates.length > cap;
	const toParse = capped ? parseCandidates.slice(0, cap) : parseCandidates;
	const values: unknown[] = [];
	for (const candidate of toParse) {
		const { entry, stat } = candidate;
		const file = path.join(dir, entry);
		let source: string;
		try {
			source = authority
				? await authority.readFile(entry, "utf8", stat)
				: await (io.readFileSafe ?? io.readFile)(file, "utf8", stat);
		} catch (error) {
			if (
				(error as NodeJS.ErrnoException).code === "ENOENT" ||
				(error as NodeJS.ErrnoException).code === "ELOOP" ||
				error instanceof ProjectionScanRaceError
			) {
				raced += 1;
				skippedEmpty += 1;
				continue;
			}
			throw error;
		}
		try {
			values.push(JSON.parse(source));
		} catch (error) {
			throw new Error(
				`invalid coordinator projection ${file}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	let finalRoot: ProjectionScanStat;
	try {
		finalRoot = authority?.stat ?? (await io.lstat(dir));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return {
			values: [],
			parsed: 0,
			capped: true,
			skippedDebris,
			skippedEmpty,
			raced: raced + 1,
			incomplete: true,
		};
	}
	if (hasProjectionRootIdentity(rootStat) && !sameProjectionRoot(rootStat, finalRoot)) {
		return {
			values: [],
			parsed: 0,
			capped: true,
			skippedDebris,
			skippedEmpty,
			raced: raced + 1,
			incomplete: true,
		};
	}
	return {
		values: values.filter(value => value !== null),
		parsed: values.length,
		// Existing authoritative callers already refuse a capped scan. Treat a raced
		// candidate as the same incomplete boundary so they cannot consume a partial
		// projection set while the result still reports the precise race count below.
		capped: capped || raced > 0,
		skippedDebris,
		skippedEmpty,
		raced,
		incomplete: capped || raced > 0,
	};
}

export async function listCoordinatorJsonFiles(
	dir: string,
	io: ProjectionScanFs = defaultFs,
	cap: number = COORDINATOR_JSON_SCAN_CAP,
): Promise<ProjectionScanResult> {
	let authority: ProjectionScanDirectory | undefined;
	try {
		authority = io.openDirectory ? await io.openDirectory(dir) : undefined;
		return await scanCoordinatorJsonFiles(dir, io, cap, authority);
	} catch (error) {
		if (
			error instanceof ProjectionScanRaceError ||
			error instanceof ProjectionScanUnsupportedError ||
			(error as NodeJS.ErrnoException).code === PROJECTION_SCAN_UNSUPPORTED_CODE
		) {
			return {
				values: [],
				parsed: 0,
				capped: true,
				skippedDebris: 0,
				skippedEmpty: 0,
				raced: 1,
				incomplete: true,
			};
		}
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			// No authority was returned: this is the lazy first-use shape for an
			// otherwise valid projection namespace, not a partial scan. Once an
			// authority exists, ENOENT is handled by scanCoordinatorJsonFiles as a
			// raced/incomplete result and cannot reach this branch.
			return {
				values: [],
				parsed: 0,
				capped: false,
				skippedDebris: 0,
				skippedEmpty: 0,
				raced: 0,
				incomplete: false,
			};
		}
		throw error;
	} finally {
		await authority?.close().catch(() => undefined);
	}
}

/**
 * Retry only scans invalidated by observed directory/file churn. A candidate cap,
 * unsupported authority, parse error, or any other failure remains fail-closed.
 * Each attempt acquires a new authority, so no partial result crosses attempts.
 */
export async function listCoordinatorJsonFilesWithRetry(
	dir: string,
	io: ProjectionScanFs = defaultFs,
	cap: number = COORDINATOR_JSON_SCAN_CAP,
	maxAttempts: number = COORDINATOR_JSON_SCAN_RETRY_ATTEMPTS,
): Promise<ProjectionScanResult> {
	const attempts = Math.max(1, Math.floor(maxAttempts));
	let scan = await listCoordinatorJsonFiles(dir, io, cap);
	for (let attempt = 1; attempt < attempts && scan.incomplete && scan.raced > 0; attempt++) {
		scan = await listCoordinatorJsonFiles(dir, io, cap);
	}
	return scan;
}
