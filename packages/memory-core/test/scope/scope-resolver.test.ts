import { describe, expect, it } from "bun:test";

import type { MemoryEnvironment, RepositorySnapshot } from "../../src/env";
import type { MemoryResult } from "../../src/errors";
import { resolveScopes, type ScopeResolutionResult, scopeByKind } from "../../src/scope/scope-resolver";

function repository(): RepositorySnapshot {
	return {
		worktreeRoot: "/workspace/widget",
		commonDir: "/workspace/widget/.git",
		isLinkedWorktree: false,
		remotes: [{ name: "origin", url: "git@github.com:acme/widget.git" }],
	};
}

function environment(
	repositorySnapshot: RepositorySnapshot | null,
	sessionId: string | null,
	memoryRoot = "/profiles/test/memory",
): MemoryEnvironment {
	return {
		memoryRoot,
		repository: repositorySnapshot,
		sessionId,
		now: new Date("2026-07-29T00:00:00.000Z"),
		deterministic: true,
		asOf: "2026-07-29T00:00:00.000Z",
	};
}

function resolutionOf(result: MemoryResult<ScopeResolutionResult>): ScopeResolutionResult {
	if (!result.ok) throw new Error("unexpected failed scope resolution");
	return result.value;
}

describe("scope resolver", () => {
	it("returns exactly global, project, and session under the canonical memory root", () => {
		const result = resolveScopes(environment(repository(), "session-01", "/profiles/test/memory/../memory"));
		expect(result.ok).toBe(true);
		const resolution = resolutionOf(result);
		expect(resolution.memoryRoot).toBe("/profiles/test/memory");
		expect(resolution.scopes.map(scope => scope.kind)).toEqual(["global", "project", "session"]);
		for (const scope of resolution.scopes) {
			expect(scope.available).toBe(true);
			expect(scope.writable).toBe(true);
			expect(scope.root).not.toBeNull();
			if (scope.root !== null) {
				expect(scope.root === resolution.memoryRoot || scope.root.startsWith(`${resolution.memoryRoot}/`)).toBe(
					true,
				);
			}
		}
		expect(scopeByKind(resolution, "global")?.root).toBe("/profiles/test/memory/global");
	});

	it("marks project and session unavailable without fabricating roots", () => {
		const result = resolveScopes(environment(null, null));
		const resolution = resolutionOf(result);
		const project = scopeByKind(resolution, "project");
		const session = scopeByKind(resolution, "session");
		expect(project).toEqual({
			kind: "project",
			root: null,
			writable: false,
			available: false,
			unavailableReason: "project repository snapshot is unavailable",
		});
		expect(session).toEqual({
			kind: "session",
			root: null,
			writable: false,
			available: false,
			unavailableReason: "session id is unavailable",
		});
		expect(scopeByKind(resolution, "global")?.root).toBe("/profiles/test/memory/global");
	});

	it("accepts a linked worktree snapshot while retaining the shared project key", () => {
		const linked: RepositorySnapshot = {
			...repository(),
			worktreeRoot: "/workspace/widget-linked",
			isLinkedWorktree: true,
		};
		const first = resolutionOf(resolveScopes(environment(repository(), "s")));
		const second = resolutionOf(resolveScopes(environment(linked, "s")));
		expect(first.project.encodedKey).toBe(second.project.encodedKey);
		expect(scopeByKind(first, "project")?.root).toBe(scopeByKind(second, "project")?.root);
	});

	it("rejects unsafe session ids before constructing a path", () => {
		const result = resolveScopes(environment(repository(), "../outside"));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("invalid-input");
	});

	it("rejects an invalid registry key rather than falling back", () => {
		const result = resolveScopes(
			environment(repository(), "s"),
			"version: 1\nprojects:\n  ../outside: github.com/acme/widget\n",
		);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("invalid-input");
	});
});
