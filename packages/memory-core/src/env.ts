import * as path from "node:path";

import type { MemoryResult } from "./errors";
import { invalidInput } from "./errors";

export type MemoryScopeKind = "global" | "project" | "session";

export interface RepositoryRemote {
	readonly name: string;
	readonly url: string;
}

export interface RepositorySnapshot {
	readonly worktreeRoot: string;
	readonly commonDir: string | null;
	readonly isLinkedWorktree: boolean;
	readonly remotes: readonly RepositoryRemote[];
}

export interface MemoryEnvironment {
	readonly memoryRoot: string;
	readonly repository: RepositorySnapshot | null;
	readonly sessionId: string | null;
	readonly now: Date;
	readonly deterministic: boolean;
	readonly asOf: string | null;
	readonly legacy?: {
		readonly memoriesDir: string;
		readonly agentDbPath: string;
	};
}

export interface ProjectIdentity {
	readonly forgeId: string | null;
	readonly repoRoot: string | null;
	readonly gitCommonDir: string | null;
	readonly isLinkedWorktree: boolean;
	readonly encodedKey: string;
	readonly source: "forge-remote" | "repo-root" | "path-fallback";
}

export interface ResolvedScope {
	readonly kind: MemoryScopeKind;
	readonly root: string;
	readonly writable: boolean;
}

export interface ScopeResolution {
	readonly schemaVersion: "gajae.memory.scope-resolution.v1";
	readonly memoryRoot: string;
	readonly project: ProjectIdentity;
	readonly sessionId: string | null;
	readonly scopes: readonly ResolvedScope[];
}

const AS_OF_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const MAX_SESSION_ID_LENGTH = 100;
const WINDOWS_DEVICE_NAME_PATTERN = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

function isSafeSessionId(value: string): boolean {
	if (value.length === 0 || value.length > MAX_SESSION_ID_LENGTH || value.trim() !== value) return false;
	if (value === "." || value === ".." || value.includes("/") || value.includes("\\") || value.includes("\u0000")) {
		return false;
	}
	if ([...value].some(character => character.charCodeAt(0) < 0x20 || character === ":")) return false;
	if (/[. ]$/.test(value) || WINDOWS_DEVICE_NAME_PATTERN.test(value)) return false;
	return true;
}

function isAbsolutePath(value: string): boolean {
	return value.length > 0 && path.isAbsolute(value) && !value.includes("\u0000");
}

function isValidAsOf(value: string): boolean {
	if (!AS_OF_PATTERN.test(value)) return false;
	return Number.isFinite(Date.parse(value));
}

function isRepositorySnapshot(value: RepositorySnapshot | null | undefined): value is RepositorySnapshot {
	if (value === null || value === undefined || typeof value !== "object") return false;
	if (typeof value.worktreeRoot !== "string" || !isAbsolutePath(value.worktreeRoot)) return false;
	if (value.commonDir !== null && (typeof value.commonDir !== "string" || !isAbsolutePath(value.commonDir)))
		return false;
	if (typeof value.isLinkedWorktree !== "boolean" || !Array.isArray(value.remotes)) return false;
	return value.remotes.every(
		remote =>
			remote !== null &&
			typeof remote === "object" &&
			typeof remote.name === "string" &&
			remote.name.length > 0 &&
			typeof remote.url === "string" &&
			remote.url.length > 0,
	);
}

export function validateMemoryEnvironment(environment: MemoryEnvironment): MemoryResult<MemoryEnvironment> {
	if (environment === null || typeof environment !== "object" || Array.isArray(environment)) {
		return invalidInput("memory environment must be an object");
	}
	if (typeof environment.memoryRoot !== "string" || !isAbsolutePath(environment.memoryRoot)) {
		return invalidInput("memoryRoot must be an absolute path");
	}
	if (environment.repository === undefined) return invalidInput("repository must be null or a snapshot");
	if (environment.repository !== null && !isRepositorySnapshot(environment.repository)) {
		return invalidInput("repository snapshot is invalid");
	}
	if (environment.sessionId === undefined) return invalidInput("sessionId must be null or a safe path component");
	if (
		environment.sessionId !== null &&
		(typeof environment.sessionId !== "string" || !isSafeSessionId(environment.sessionId))
	) {
		return invalidInput("sessionId is not a safe path component");
	}
	if (!(environment.now instanceof Date) || !Number.isFinite(environment.now.getTime())) {
		return invalidInput("now must be a valid Date");
	}
	if (typeof environment.deterministic !== "boolean") {
		return invalidInput("deterministic must be a boolean");
	}
	if (environment.asOf === undefined) return invalidInput("asOf must be null or strict ISO-8601 UTC");
	if (environment.asOf !== null && (typeof environment.asOf !== "string" || !isValidAsOf(environment.asOf))) {
		return invalidInput("asOf must be strict ISO-8601 UTC");
	}
	if (environment.deterministic && environment.asOf === null) {
		return invalidInput("deterministic mode requires asOf");
	}
	if (environment.legacy !== undefined) {
		if (
			environment.legacy === null ||
			typeof environment.legacy !== "object" ||
			typeof environment.legacy.memoriesDir !== "string" ||
			typeof environment.legacy.agentDbPath !== "string" ||
			!isAbsolutePath(environment.legacy.memoriesDir) ||
			!isAbsolutePath(environment.legacy.agentDbPath)
		) {
			return invalidInput("legacy paths must be absolute");
		}
	}
	return { ok: true, value: environment };
}
