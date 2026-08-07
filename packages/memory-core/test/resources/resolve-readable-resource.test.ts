import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { MemoryEnvironment, RepositorySnapshot } from "../../src/env";
import type { MemoryError, MemoryResult } from "../../src/errors";

import { listReadableDirectory } from "../../src/resources/list-readable-directory";
import { readControlResource } from "../../src/resources/read-control-resource";
import { resolveReadableResource } from "../../src/resources/resolve-readable-resource";
import { resolveReadableResourceSync } from "../../src/resources/resolve-readable-resource-sync";
import { resolveScopes, scopeByKind } from "../../src/scope/scope-resolver";
import { createMemoryRootScaffold } from "../../src/storage/bootstrap-init";

const temporaryRoots: string[] = [];

const REPOSITORY: RepositorySnapshot = {
	worktreeRoot: "/workspace/widget",
	commonDir: "/workspace/widget/.git",
	isLinkedWorktree: false,
	remotes: [{ name: "origin", url: "git@github.com:acme/widget.git" }],
};

function environment(
	memoryRoot: string,
	repository: RepositorySnapshot | null,
	sessionId: string | null,
): MemoryEnvironment {
	return {
		memoryRoot,
		repository,
		sessionId,
		now: new Date("2026-07-29T00:00:00.000Z"),
		deterministic: true,
		asOf: "2026-07-29T00:00:00.000Z",
	};
}

function frontmatter(
	scope: "global" | "project" | "session",
	id: string,
	options: { readonly sensitivity?: "public-safe" | "private" | "restricted"; readonly status?: string } = {},
): string {
	return `---
schemaVersion: gajae.memory.document.v1
id: ${id}
type: fact
scope: ${scope}
authority: user-confirmed
volatility: stable
sensitivity: ${options.sensitivity ?? "public-safe"}
status: ${options.status ?? "active"}
created: 2026-07-29T00:00:00Z
updated: 2026-07-29T00:00:00.000Z
aliases: []
supersedes: []
verification:
  provider: local
  resource: fixture
  id: ${id}
---
# ${id}
Readable body.
`;
}

async function makeRoot(): Promise<string> {
	const parent = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "memory-core-resource-")));
	const root = path.join(parent, "memory");
	temporaryRoots.push(parent);
	await createMemoryRootScaffold(root);
	return root;
}

async function writeDocument(root: string, relPath: string, content: string): Promise<void> {
	const target = path.join(root, ...relPath.split("/"));
	await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
	await fsp.chmod(path.dirname(target), 0o700);
	await fsp.writeFile(target, content, { mode: 0o600 });
}

function projectKey(root: string, sessionId: string | null = "session-1"): string {
	const resolution = resolveScopes(environment(root, REPOSITORY, sessionId));
	if (!resolution.ok) throw new Error("project scope could not be resolved");
	const descriptor = scopeByKind(resolution.value, "project");
	if (descriptor?.root === null || descriptor?.root === undefined) throw new Error("project scope is unavailable");
	return path.basename(descriptor.root);
}

function expectCode(result: MemoryResult<unknown>, code: MemoryError["code"]): void {
	expect(result.ok).toBe(false);
	if (!result.ok) {
		const error: MemoryError = result.error;
		expect(error.code).toBe(code);
	}
}

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map(root => fsp.rm(root, { recursive: true, force: true })));
});

describe("policy-checked readable resources", () => {
	it("reads global, project, and session markdown with deterministic metadata", async () => {
		const root = await makeRoot();
		const key = projectKey(root);
		await writeDocument(root, "global/profile.md", frontmatter("global", "global-profile"));
		await writeDocument(root, `projects/${key}/project.md`, frontmatter("project", "project-note"));
		await writeDocument(root, "sessions/session-1/session.md", frontmatter("session", "session-note"));

		const global = await resolveReadableResource(environment(root, REPOSITORY, "session-1"), {
			uri: "global://profile.md",
		});
		const project = await resolveReadableResource(
			environment(root, REPOSITORY, "session-1"),
			`project://${key}/project.md`,
		);
		const session = await resolveReadableResource(
			environment(root, REPOSITORY, "session-1"),
			"session://session-1/session.md",
		);

		for (const result of [global, project, session]) {
			expect(result.ok).toBe(true);
			if (!result.ok) continue;
			expect(result.value.contentType).toBe("text/markdown");
			expect(result.value.size).toBe(Buffer.byteLength(result.value.content, "utf8"));
			expect(result.value.digest).toMatch(/^[0-9a-f]{64}$/);
			expect(result.value.citation.digest).toBe(result.value.digest);
			expect(Object.hasOwn(result.value, "absolutePath")).toBe(false);
		}
		expect(global.ok && global.value.uri).toBe("global://profile.md");
		expect(project.ok && project.value.relPath).toBe(`projects/${key}/project.md`);
		expect(session.ok && session.value.relPath).toBe("sessions/session-1/session.md");
	});

	it("returns a verified absolute path only from the sync hyperlink sibling", async () => {
		const root = await makeRoot();
		await writeDocument(root, "global/profile.md", frontmatter("global", "global-profile"));

		const result = resolveReadableResourceSync(environment(root, REPOSITORY, null), "global://profile.md");
		expect(result).toEqual({ ok: true, value: { absolutePath: path.join(root, "global/profile.md") } });
	});

	it("maps missing files, unavailable scopes, malformed URIs, and malformed documents to typed failures", async () => {
		const root = await makeRoot();
		const missing = await resolveReadableResource(environment(root, REPOSITORY, null), "global://missing.md");
		expectCode(missing, "not-found");

		const unavailable = await resolveReadableResource(environment(root, null, null), "project://missing/key.md");
		expectCode(unavailable, "scope-unresolved");

		const malformedUri = await resolveReadableResource(environment(root, REPOSITORY, null), "global://../escape.md");
		expectCode(malformedUri, "invalid-input");

		await writeDocument(root, "global/broken.md", "not a memory document\n");
		const malformedDocument = await resolveReadableResource(
			environment(root, REPOSITORY, null),
			"global://broken.md",
		);
		expectCode(malformedDocument, "malformed-document");
	});

	it("denies excluded paths and non-markdown resources before opening a descriptor", async () => {
		const root = await makeRoot();
		await writeDocument(root, "global/archive/old.md", frontmatter("global", "old"));
		await writeDocument(root, "global/proposals/draft.md", frontmatter("global", "draft"));
		await writeDocument(root, "global/transcripts/run.md", frontmatter("global", "run"));
		await writeDocument(root, "global/events.jsonl", "{}\n");
		await writeDocument(root, "global/readme.txt", "not markdown\n");

		const readSyncSpy = spyOn(fs, "readSync");
		try {
			const denied = [
				"global://archive/old.md",
				"global://proposals/draft.md",
				"global://transcripts/run.md",
				"global://events.jsonl",
				"global://readme.txt",
			];
			for (const uri of denied) {
				const result = await resolveReadableResource(environment(root, REPOSITORY, null), uri);
				expectCode(result, "policy-denied");
			}
			expect(readSyncSpy).not.toHaveBeenCalled();
		} finally {
			readSyncSpy.mockRestore();
		}
	});

	it("denies proposed, private, restricted, symlinked, and traversal targets", async () => {
		const root = await makeRoot();
		await writeDocument(root, "global/proposed.md", frontmatter("global", "proposed", { status: "proposed" }));
		await writeDocument(root, "global/private.md", frontmatter("global", "private", { sensitivity: "private" }));
		await writeDocument(
			root,
			"global/restricted.md",
			frontmatter("global", "restricted", { sensitivity: "restricted" }),
		);
		expectCode(
			await resolveReadableResource(environment(root, REPOSITORY, null), "global://proposed.md"),
			"policy-denied",
		);
		expectCode(
			await resolveReadableResource(environment(root, REPOSITORY, null), "global://private.md"),
			"sensitivity-violation",
		);
		expectCode(
			await resolveReadableResource(environment(root, REPOSITORY, null), "global://restricted.md"),
			"sensitivity-violation",
		);
		expectCode(
			await resolveReadableResource(environment(root, REPOSITORY, null), "global://%2e%2e/private.md"),
			"invalid-input",
		);

		if (process.platform !== "win32") {
			const outside = path.join(path.dirname(root), "outside.md");
			await fsp.writeFile(outside, frontmatter("global", "outside"), { mode: 0o600 });
			await fsp.symlink(outside, path.join(root, "global/link.md"));
			const symlink = await resolveReadableResource(environment(root, REPOSITORY, null), "global://link.md");
			expectCode(symlink, "policy-denied");
		}
	});

	it("returns not-initialized after the memory root is deleted", async () => {
		const root = await makeRoot();
		await writeDocument(root, "global/profile.md", frontmatter("global", "global-profile"));
		await fsp.rm(root, { recursive: true, force: true });

		const asyncResult = await resolveReadableResource(environment(root, REPOSITORY, null), "global://profile.md");
		const syncResult = resolveReadableResourceSync(environment(root, REPOSITORY, null), "global://profile.md");
		expectCode(asyncResult, "not-initialized");
		expectCode(syncResult, "not-initialized");
	});

	it("reads fixed control files without frontmatter and lists only bound directories", async () => {
		const root = await makeRoot();
		await fsp.writeFile(path.join(root, "MEMORY.md"), "plain map text\n", { mode: 0o600 });
		await fsp.writeFile(path.join(root, "routes.yaml"), "version: 1\nroutes: {}\n", { mode: 0o600 });
		const map = readControlResource(environment(root, REPOSITORY, null), "MEMORY.md");
		const routes = readControlResource(environment(root, REPOSITORY, null), "routes.yaml");
		expect(map.ok).toBe(true);
		expect(routes.ok).toBe(true);
		if (map.ok) expect(map.value.content).toBe("plain map text\n");
		if (routes.ok) expect(routes.value.content).toContain("version: 1");
		await writeDocument(root, "global/readable.md", frontmatter("global", "readable"));
		const listed = listReadableDirectory(environment(root, REPOSITORY, null), {
			kind: "global",
			root: path.join(root, "global"),
		});
		expect(listed.ok).toBe(true);
		if (listed.ok)
			expect(listed.value.filter(entry => entry.kind === "file").map(entry => entry.name)).toEqual(["readable.md"]);
		if (process.platform !== "win32") {
			const outside = path.join(path.dirname(root), "outside-directory");
			await fsp.mkdir(outside, { mode: 0o700 });
			await fsp.symlink(outside, path.join(root, "global", "escape"));
			const escaped = listReadableDirectory(environment(root, REPOSITORY, null), {
				kind: "global",
				root: path.join(root, "global"),
			});
			expect(escaped.ok).toBe(false);
		}
	});

	it("lists scope roots given through a configured root alias and reports absent lazy scopes", async () => {
		const root = await makeRoot();
		await writeDocument(root, "global/aliased.md", frontmatter("global", "aliased"));
		// The configured root may be an alias of the pinned canonical root (macOS
		// `/var` vs `/private/var`), and project/session scopes stay lazy until a
		// write creates them. Both must resolve without a containment failure.
		const canonicalRoot = fs.realpathSync.native(root);
		const listed = listReadableDirectory(environment(root, REPOSITORY, "session-1"), {
			kind: "global",
			root: path.join(canonicalRoot, "global"),
		});
		expect(listed.ok).toBe(true);
		if (listed.ok) {
			expect(listed.value.filter(entry => entry.kind === "file").map(entry => entry.name)).toEqual(["aliased.md"]);
		}

		const lazySession = listReadableDirectory(environment(root, REPOSITORY, "session-1"), {
			kind: "session",
			root: path.join(root, "sessions", "session-1"),
		});
		expect(lazySession.ok).toBe(true);
		if (lazySession.ok) expect(lazySession.value).toEqual([]);
	});
});
