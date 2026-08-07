import { describe, expect, it } from "bun:test";

import type { RepositoryRemote, RepositorySnapshot } from "../../src/env";
import {
	chooseRemote,
	deriveForgeProjectKey,
	normalizeRemoteUrl,
	resolveProjectIdentity,
} from "../../src/scope/project-identity";
import { parseProjectRegistry } from "../../src/scope/registry";

function snapshot(
	worktreeRoot: string,
	commonDir: string | null,
	remotes: readonly RepositoryRemote[],
	isLinkedWorktree = false,
): RepositorySnapshot {
	return { worktreeRoot, commonDir, isLinkedWorktree, remotes };
}

function unwrapResult<T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false }): T {
	if (!result.ok) throw new Error("unexpected failed result");
	return result.value;
}

describe("project identity", () => {
	it("normalizes SCP, HTTPS, and SSH remotes without credentials or default ports", () => {
		expect(normalizeRemoteUrl("git@GitHub.COM:Acme/Widget.git")).toBe("github.com/Acme/Widget");
		expect(normalizeRemoteUrl("https://user:secret@GitHub.COM:443/Acme/Widget.git")).toBe("github.com/Acme/Widget");
		expect(normalizeRemoteUrl("ssh://git:secret@GitHub.COM:22/Acme/Widget.git")).toBe("github.com/Acme/Widget");
		expect(normalizeRemoteUrl("https://GitHub.COM:8443/Acme/Widget.git")).toBe("github.com:8443/Acme/Widget");
	});

	it("rejects malformed, unsupported, and ambiguous remote forms", () => {
		for (const remote of [
			"",
			"https://github.com/Acme",
			"https://github.com/Acme/Widget/extra",
			"https://github.com/Acme/Widget?ref=main",
			"ssh://github.com/Acme/Widget/",
			"git://github.com/Acme/Widget.git",
			"git@github.com:Acme/Widget/extra.git",
			"https://github.com/../Widget.git",
		]) {
			expect(normalizeRemoteUrl(remote)).toBeNull();
		}
	});

	it("chooses upstream, then origin, then NFC UTF-8 name order with deterministic ties", () => {
		const upstream = chooseRemote([
			{ name: "origin", url: "git@example.com:acme/origin.git" },
			{ name: "upstream", url: "git@example.com:acme/upstream.git" },
		]);
		expect(unwrapResult(upstream)?.forgeId).toBe("example.com/acme/upstream");

		const origin = chooseRemote([
			{ name: "zeta", url: "git@example.com:acme/zeta.git" },
			{ name: "origin", url: "git@example.com:acme/origin.git" },
		]);
		expect(unwrapResult(origin)?.forgeId).toBe("example.com/acme/origin");

		const ordered = chooseRemote([
			{ name: "zeta", url: "git@example.com:acme/zeta.git" },
			{ name: "e\u0301", url: "git@example.com:acme/decomposed.git" },
			{ name: "é", url: "git@example.com:acme/composed.git" },
		]);
		expect(unwrapResult(ordered)?.name).toBe("zeta");

		const tied = chooseRemote([
			{ name: "é", url: "git@example.com:acme/zulu.git" },
			{ name: "e\u0301", url: "git@example.com:acme/alpha.git" },
		]);
		expect(unwrapResult(tied)?.url).toBe("git@example.com:acme/alpha.git");
	});

	it("derives a forge key for a canonical checkout and keeps it stable across URL forms", () => {
		const first = resolveProjectIdentity(
			snapshot("/work/widget", "/work/widget/.git", [{ name: "origin", url: "git@GitHub.com:Acme/Widget.git" }]),
		);
		const second = resolveProjectIdentity(
			snapshot("/work/widget", "/work/widget/.git", [{ name: "origin", url: "https://github.com/Acme/Widget" }]),
		);
		expect(first).toEqual(second);
		if (first.ok) {
			expect(first.value.source).toBe("forge-remote");
			expect(first.value.repoRoot).toBe("/work/widget");
			expect(first.value.gitCommonDir).toBe("/work/widget/.git");
			expect(first.value.encodedKey).toMatch(/^[A-Za-z0-9._-]+$/);
			expect(first.value.encodedKey.length).toBeLessThanOrEqual(56);
		}
	});

	it("resolves linked worktrees to one common project key", () => {
		const first = resolveProjectIdentity(
			snapshot(
				"/work/widget-a",
				"/work/widget/.git",
				[{ name: "origin", url: "git@github.com:acme/widget.git" }],
				true,
			),
		);
		const second = resolveProjectIdentity(
			snapshot(
				"/work/widget-b",
				"/work/widget/.git",
				[{ name: "origin", url: "git@github.com:acme/widget.git" }],
				true,
			),
		);
		expect(unwrapResult(first).encodedKey).toBe(unwrapResult(second).encodedKey);
		expect(unwrapResult(first).repoRoot).not.toBe(unwrapResult(second).repoRoot);
	});

	it("keeps unrelated repositories distinct and falls back to a common directory hash", () => {
		const first = resolveProjectIdentity(snapshot("/work/one", "/work/one/.git", []));
		const second = resolveProjectIdentity(snapshot("/work/two", "/work/two/.git", []));
		expect(unwrapResult(first).source).toBe("repo-root");
		expect(unwrapResult(second).source).toBe("repo-root");
		expect(unwrapResult(first).encodedKey).not.toBe(unwrapResult(second).encodedKey);
	});

	it("uses the registry before deriving a key and preserves a key by common directory", () => {
		const registry = parseProjectRegistry(`version: 1
projects:
  existing-widget:
    forgeId: github.com/old/widget
    gitCommonDir: /repos/widget/.git
`);
		const resolved = resolveProjectIdentity(
			snapshot("/work/widget", "/repos/widget/.git", [
				{ name: "origin", url: "https://new.example/Acme/Widget.git" },
			]),
			unwrapResult(registry),
		);
		expect(unwrapResult(resolved).encodedKey).toBe("existing-widget");

		const renamedRemote = parseProjectRegistry(`version: 1
projects:
  github.com/Acme/Widget: existing-widget
`);
		const renamed = resolveProjectIdentity(
			snapshot("/work/widget", "/work/widget/.git", [{ name: "upstream", url: "git@github.com:Acme/Widget.git" }]),
			unwrapResult(renamedRemote),
		);
		expect(unwrapResult(renamed).encodedKey).toBe("existing-widget");
	});

	it("fails closed for malformed registry data and unsafe keys", () => {
		expect(parseProjectRegistry("version: 2\nprojects: {}\n").ok).toBe(false);
		expect(parseProjectRegistry("version: 1\nprojects:\n  ../escape: github.com/acme/widget\n").ok).toBe(false);
		const identity = resolveProjectIdentity(
			snapshot("/work/widget", "/work/widget/.git", [{ name: "origin", url: "git@github.com:acme/widget.git" }]),
			"version: 1\nprojects:\n  ../escape: github.com/acme/widget\n",
		);
		expect(identity.ok).toBe(false);
		expect(deriveForgeProjectKey("not-a-forge-id").ok).toBe(false);
	});

	it("returns an explicit path-fallback identity when no repository snapshot is injected", () => {
		const result = resolveProjectIdentity(null);
		expect(result).toEqual({
			ok: true,
			value: {
				forgeId: null,
				repoRoot: null,
				gitCommonDir: null,
				isLinkedWorktree: false,
				encodedKey: "",
				source: "path-fallback",
			},
		});
	});
});
