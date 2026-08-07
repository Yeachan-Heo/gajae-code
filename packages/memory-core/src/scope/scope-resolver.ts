import * as path from "node:path";

import type { MemoryEnvironment, MemoryScopeKind, ProjectIdentity } from "../env";
import { validateMemoryEnvironment } from "../env";
import type { MemoryResult } from "../errors";
import { invalidInput } from "../errors";
import { type ProjectIdentityRegistry, resolveProjectIdentity } from "./project-identity";

export interface ResolvedScopeDescriptor {
	readonly kind: MemoryScopeKind;
	readonly root: string | null;
	readonly writable: boolean;
	readonly available: boolean;
	readonly unavailableReason: string | null;
}

export interface ScopeResolutionResult {
	readonly schemaVersion: "gajae.memory.scope-resolution.v1";
	readonly memoryRoot: string;
	readonly project: ProjectIdentity;
	readonly sessionId: string | null;
	readonly scopes: readonly ResolvedScopeDescriptor[];
}

const SCOPE_KINDS = ["global", "project", "session"] as const satisfies readonly MemoryScopeKind[];
const WINDOWS_DEVICE_NAME_PATTERN = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

function isAbsolutePath(value: string): boolean {
	return path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || /^[/\\]{2}/.test(value);
}

function canonicalPath(value: string): string | null {
	if (typeof value !== "string" || value.length === 0 || value.includes("\u0000") || !isAbsolutePath(value))
		return null;
	return path.normalize(path.resolve(value));
}

function isSafePathComponent(value: string): boolean {
	if (
		value.length === 0 ||
		value.length > 128 ||
		value.normalize("NFC") !== value ||
		value === "." ||
		value === ".." ||
		value.includes("/") ||
		value.includes("\\") ||
		value.includes("\u0000") ||
		/[\u0000-\u001f\u007f:]/.test(value) ||
		/[. ]$/.test(value) ||
		WINDOWS_DEVICE_NAME_PATTERN.test(value)
	) {
		return false;
	}
	return true;
}

function containedPath(root: string, components: readonly string[]): string | null {
	if (components.some(component => !isSafePathComponent(component))) return null;
	const candidate = path.normalize(path.resolve(root, ...components));
	const relative = path.relative(root, candidate);
	if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) return null;
	return candidate;
}

function unavailable(kind: MemoryScopeKind, reason: string): ResolvedScopeDescriptor {
	return Object.freeze({ kind, root: null, writable: false, available: false, unavailableReason: reason });
}

function available(kind: MemoryScopeKind, root: string): ResolvedScopeDescriptor {
	return Object.freeze({ kind, root, writable: true, available: true, unavailableReason: null });
}

/** Resolve the three private memory scopes from already-injected environment facts. */
export function resolveScopes(
	environment: MemoryEnvironment,
	registryInput?: ProjectIdentityRegistry,
): MemoryResult<ScopeResolutionResult> {
	const validatedEnvironment = validateMemoryEnvironment(environment);
	if (!validatedEnvironment.ok) return validatedEnvironment;
	const memoryRoot = canonicalPath(environment.memoryRoot);
	if (memoryRoot === null) return invalidInput("memoryRoot must be an absolute path");
	const project = resolveProjectIdentity(environment.repository, registryInput);
	if (!project.ok) return project;

	const globalRoot = containedPath(memoryRoot, ["global"]);
	if (globalRoot === null) return invalidInput("global scope path escapes memory root");
	const projectRoot =
		project.value.encodedKey.length === 0 ? null : containedPath(memoryRoot, ["projects", project.value.encodedKey]);
	if (project.value.encodedKey.length > 0 && projectRoot === null) {
		return invalidInput("project scope key is unsafe");
	}
	const sessionRoot =
		environment.sessionId === null ? null : containedPath(memoryRoot, ["sessions", environment.sessionId]);
	if (environment.sessionId !== null && sessionRoot === null) {
		return invalidInput("session scope id is unsafe");
	}

	const scopes: ResolvedScopeDescriptor[] = [
		available("global", globalRoot),
		projectRoot === null
			? unavailable("project", "project repository snapshot is unavailable")
			: available("project", projectRoot),
		sessionRoot === null ? unavailable("session", "session id is unavailable") : available("session", sessionRoot),
	];
	return {
		ok: true,
		value: Object.freeze({
			schemaVersion: "gajae.memory.scope-resolution.v1",
			memoryRoot,
			project: project.value,
			sessionId: environment.sessionId,
			scopes: Object.freeze(scopes),
		}),
	};
}

export function scopeByKind(resolution: ScopeResolutionResult, kind: MemoryScopeKind): ResolvedScopeDescriptor | null {
	return resolution.scopes.find(scope => scope.kind === kind) ?? null;
}

export const resolveScope = resolveScopes;

export { SCOPE_KINDS };
