import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { MemoryEnvironment } from "../../src/env";
import type { ScopeResolutionResult } from "../../src/scope/scope-resolver";
import type { CandidateDirectoryEntry } from "../../src/search/candidate-universe";
import { type RetrievalDependencies, recallMemory, runRetrievalPipeline } from "../../src/search/retrieval-pipeline";
import { createMemoryRootScaffold } from "../../src/storage/bootstrap-init";

const AS_OF = "2026-07-29T00:00:00.000Z";
const temporaryRoots: string[] = [];

function frontmatter(id: string, aliases: readonly string[] = [], type = "fact"): string {
	return [
		"---",
		"schemaVersion: gajae.memory.document.v1",
		`id: ${id}`,
		`type: ${type}`,
		"scope: global",
		"authority: user-confirmed",
		"volatility: stable",
		"sensitivity: public-safe",
		"status: active",
		`created: ${AS_OF}`,
		`updated: ${AS_OF}`,
		`aliases: [${aliases.join(", ")}]`,
		"supersedes: []",
		"---",
	].join("\n");
}

function document(id: string, body: string, aliases: readonly string[] = [], type = "fact"): string {
	return `${frontmatter(id, aliases, type)}\n${body}\n`;
}

function environment(memoryRoot: string): MemoryEnvironment {
	return {
		memoryRoot,
		repository: null,
		sessionId: null,
		now: new Date(AS_OF),
		deterministic: true,
		asOf: AS_OF,
	};
}

function scopeResolution(memoryRoot: string): ScopeResolutionResult {
	return {
		schemaVersion: "gajae.memory.scope-resolution.v1",
		memoryRoot,
		project: {
			forgeId: null,
			repoRoot: null,
			gitCommonDir: null,
			isLinkedWorktree: false,
			encodedKey: "",
			source: "path-fallback",
		},
		sessionId: null,
		scopes: [
			{ kind: "global", root: "/virtual/global", writable: true, available: true, unavailableReason: null },
			{ kind: "project", root: null, writable: false, available: false, unavailableReason: "no project" },
			{ kind: "session", root: null, writable: false, available: false, unavailableReason: "no session" },
		],
	};
}

type Fixture = Readonly<{
	environment: MemoryEnvironment;
	dependencies: RetrievalDependencies;
}>;

async function fixture(
	files: Readonly<Record<string, string>>,
	options: {
		readonly map?: string;
		readonly routes?: string;
		readonly entries?: readonly (CandidateDirectoryEntry | string)[];
		readonly onRead?: (uri: string) => void;
	} = {},
): Promise<Fixture> {
	const memoryRoot = await fs.mkdtemp(path.join(process.cwd(), ".memory-retrieval-test-"));
	temporaryRoots.push(memoryRoot);
	const entriesFor = (relPath: string): readonly CandidateDirectoryEntry[] => {
		const prefix = relPath.length === 0 ? "" : `${relPath}/`;
		const children = new Map<string, CandidateDirectoryEntry["kind"]>();
		for (const name of Object.keys(files)) {
			if (!name.startsWith(prefix)) continue;
			const rest = name.slice(prefix.length);
			if (rest.length === 0) continue;
			const slash = rest.indexOf("/");
			const child = slash < 0 ? rest : rest.slice(0, slash);
			children.set(child, slash < 0 ? "file" : "directory");
		}
		return [...children.entries()]
			.sort(([left], [right]) => Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")))
			.map(([name, kind]) => ({ name, kind }));
	};
	const entries = options.entries;
	const read = async (_environment: MemoryEnvironment, uri: string) => {
		options.onRead?.(uri);
		const pathPart = uri.replace(/^global:\/\//u, "");
		const content = files[pathPart];
		return content === undefined
			? { ok: false as const, error: { code: "not-found" as const, exitCode: 5 as const, uri } }
			: { ok: true as const, value: { content } };
	};
	const dependencies: RetrievalDependencies = {
		scopeResolution: scopeResolution(memoryRoot),
		mapUris: ["memory://global/MEMORY.md"],
		mapContents: {
			"memory://global/MEMORY.md": options.map ?? "<!-- AUTO:PROJECTS START -->\n<!-- AUTO:PROJECTS END -->",
		},
		routesContent: options.routes,
		list: async (_scope, relPath) =>
			entries === undefined ? entriesFor(relPath) : relPath.length === 0 ? entries : [],
		read,
	};
	return { environment: environment(memoryRoot), dependencies };
}

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe("M2 retrieval pipeline", () => {
	it("consults a MAP route before metadata and body scans", async () => {
		const fixtureStore = await fixture(
			{ "routed.md": document("routed", "# Routed\nbody does not mention the query", ["architecture"]) },
			{
				map: [
					"<!-- AUTO:PROJECTS START -->",
					"[Architecture](memory://global/routed.md) <!-- aliases: architecture -->",
					"<!-- AUTO:PROJECTS END -->",
				].join("\n"),
			},
		);
		const result = await runRetrievalPipeline({
			environment: fixtureStore.environment,
			query: "architecture",
			dependencies: fixtureStore.dependencies,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.sources[0]?.stage).toBe("map-route");
		expect(result.value.sources[0]?.uri).toBe("global://routed.md");
	});
	it("reaches a body-only match after staged searches", async () => {
		const fixtureStore = await fixture({
			"body-only.md": document(
				"body-only",
				"# Unrelated heading\nThe deterministic needle lives only in this body.",
			),
		});
		const result = await runRetrievalPipeline({
			environment: fixtureStore.environment,
			query: "deterministic needle",
			dependencies: fixtureStore.dependencies,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.sources.map(source => source.uri)).toEqual(["global://body-only.md"]);
		expect(result.value.sources[0]?.stage).toBe("lexical");
		expect(result.value.sources[0]?.heading).toBe("Unrelated heading");
	});

	it("degrades on malformed routes without broadening beyond the candidate universe", async () => {
		const fixtureStore = await fixture(
			{ "note.md": document("note", "# Stable\nThe route parser must fail closed.") },
			{ routes: "version: nope\nroutes: {}" },
		);
		const result = await runRetrievalPipeline({
			environment: fixtureStore.environment,
			query: "route parser",
			dependencies: fixtureStore.dependencies,
			explain: true,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.explain?.stageCounts["map-route"]).toBe(0);
		expect(result.value.sources[0]?.uri).toBe("global://note.md");
		expect(result.value.partial).toBe(true);
		expect(result.value.explain?.rejectedCount).toBeGreaterThan(0);
	});

	it("rejects traversal entries and skips symlink escapes", async () => {
		const traversal = await fixture(
			{ "safe.md": document("safe", "# Safe\ninside") },
			{
				entries: [
					{ name: "../outside.md", kind: "file" },
					{ name: "safe.md", kind: "file" },
				],
			},
		);
		const traversalResult = await runRetrievalPipeline({
			environment: traversal.environment,
			query: "inside",
			dependencies: traversal.dependencies,
		});
		expect(traversalResult.ok).toBe(false);

		const symlink = await fixture(
			{ "safe.md": document("safe", "# Safe\ninside") },
			{
				entries: [
					{ name: "escape.md", kind: "symlink" },
					{ name: "safe.md", kind: "file" },
				],
			},
		);
		const symlinkResult = await runRetrievalPipeline({
			environment: symlink.environment,
			query: "inside",
			dependencies: symlink.dependencies,
		});
		expect(symlinkResult.ok).toBe(true);
		if (symlinkResult.ok) expect(symlinkResult.value.sources.map(source => source.uri)).toEqual(["global://safe.md"]);
	});

	it("deduplicates routes and excludes archive/unverified paths", async () => {
		const fixtureStore = await fixture(
			{
				"note.md": document("note", "# Stable\ncanonical content", ["canonical"]),
				"archive/old.md": document("old", "# Old\ncanonical content"),
				"unverified.md": document("bad", "# Bad\ncanonical content"),
			},
			{
				map: [
					"<!-- AUTO:PROJECTS START -->",
					"[Canonical](memory://global/note.md) <!-- aliases: canonical -->",
					"[Canonical again](memory://global/note.md)",
					"<!-- AUTO:PROJECTS END -->",
				].join("\n"),
			},
		);
		const result = await runRetrievalPipeline({
			environment: fixtureStore.environment,
			query: "canonical",
			dependencies: fixtureStore.dependencies,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.sources.map(source => source.uri)).toEqual(["global://note.md"]);
		expect(result.value.sources[0]?.stage).toBe("metadata");
	});

	it("is byte-stable and matches the deterministic recall golden", async () => {
		const fixtureStore = await fixture({
			"body-only.md": document(
				"body-only",
				"# Unrelated heading\nThe deterministic needle lives only in this body.",
			),
		});
		const input = {
			environment: fixtureStore.environment,
			query: "deterministic needle",
			dependencies: fixtureStore.dependencies,
		};
		const objectResult = await runRetrievalPipeline(input);
		const positionalResult = await runRetrievalPipeline(input.environment, input, input.dependencies);
		expect(objectResult).toEqual(positionalResult);
		expect(objectResult.ok).toBe(true);

		const first = await recallMemory(input.environment, input, input.dependencies);
		const second = await recallMemory(input.environment, input, input.dependencies);
		expect(JSON.stringify(first)).toBe(JSON.stringify(second));
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		const golden: unknown = JSON.parse(
			await fs.readFile(path.join(import.meta.dir, "../golden/recall-a.json"), "utf8"),
		);
		expect(JSON.stringify(first.value)).toBe(JSON.stringify(golden));
		expect(JSON.stringify(first)).not.toContain("/virtual/global");
		expect(JSON.stringify(first)).not.toContain("The deterministic needle lives only in this body.");
	});

	it("does not depend on an external rg executable", async () => {
		const fixtureStore = await fixture({ "note.md": document("note", "# Pure TypeScript\nlexical search") });
		const result = await runRetrievalPipeline({
			environment: fixtureStore.environment,
			query: "lexical",
			dependencies: fixtureStore.dependencies,
		});
		expect(result.ok).toBe(true);
	});

	it("loads production control files from the fixed memory-root scaffold", async () => {
		const root = await fs.mkdtemp(path.join(process.cwd(), ".memory-retrieval-production-"));
		temporaryRoots.push(root);
		await createMemoryRootScaffold(root);
		await fs.writeFile(
			path.join(root, "MEMORY.md"),
			[
				"# Memory Map",
				"",
				"<!-- AUTO:PROJECTS START -->",
				"[Architecture](memory://global/routed.md)",
				"<!-- AUTO:PROJECTS END -->",
				"",
			].join("\n"),
		);
		await fs.writeFile(path.join(root, "routes.yaml"), "version: 1\nroutes: {}\n");
		await fs.writeFile(path.join(root, "global", "routed.md"), document("routed", "# Routed\nbody"));
		const result = await runRetrievalPipeline({
			environment: environment(root),
			query: "architecture",
			explain: true,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.sources[0]?.stage).toBe("map-route");
		expect(result.value.partial).toBe(false);
		expect(result.value.explain?.mapsRead).toBe(1);
	});

	it("marks unavailable control files partial and rejects complete retrieval", async () => {
		const root = await fs.mkdtemp(path.join(process.cwd(), ".memory-retrieval-control-"));
		temporaryRoots.push(root);
		await createMemoryRootScaffold(root);
		await fs.writeFile(path.join(root, "global", "note.md"), document("note", "# Note\nbody needle"));
		await fs.rm(path.join(root, "MEMORY.md"));
		const result = await runRetrievalPipeline({
			environment: environment(root),
			query: "needle",
			explain: true,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.partial).toBe(true);
		expect(result.value.explain?.rejectedCount).toBeGreaterThan(0);
		const complete = await runRetrievalPipeline({ environment: environment(root), query: "needle", complete: true });
		expect(complete.ok).toBe(false);
		if (!complete.ok) expect(complete.error.exitCode).toBe(10);
	});

	it("reads no more than the admitted file budget before parsing bodies", async () => {
		const files: Record<string, string> = { "00-body.md": document("body", "# Body\nneedle") };
		for (let index = 1; index <= 20; index += 1) {
			const name = `${index.toString().padStart(2, "0")}-filler.md`;
			files[name] = document(name, "# Filler\nunrelated");
		}
		let readCount = 0;
		const fixtureStore = await fixture(files, { onRead: () => (readCount += 1) });
		const result = await runRetrievalPipeline({
			environment: fixtureStore.environment,
			query: "needle",
			dependencies: fixtureStore.dependencies,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(readCount).toBe(20);
		expect(result.value.sources.map(source => source.uri)).toEqual(["global://00-body.md"]);
	});

	it("keeps a body-only sibling when it is within the file budget", async () => {
		const files: Record<string, string> = { "00-sibling.md": document("sibling", "# Sibling\nneedle") };
		for (let index = 1; index < 20; index += 1) {
			const name = `${index.toString().padStart(2, "0")}-filler.md`;
			files[name] = document(name, "# Filler\nunrelated");
		}
		let readCount = 0;
		const fixtureStore = await fixture(files, { onRead: () => (readCount += 1) });
		const result = await runRetrievalPipeline({
			environment: fixtureStore.environment,
			query: "needle",
			dependencies: fixtureStore.dependencies,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(readCount).toBe(20);
		expect(result.value.sources.map(source => source.uri)).toEqual(["global://00-sibling.md"]);
	});

	it("rejects stale route fragments without widening to the full document", async () => {
		const fixtureStore = await fixture(
			{ "note.md": document("note", "# Stable\narchitecture body") },
			{
				map: [
					"<!-- AUTO:PROJECTS START -->",
					"[Architecture](memory://global/note.md#Missing)",
					"<!-- AUTO:PROJECTS END -->",
				].join("\n"),
			},
		);
		const result = await runRetrievalPipeline({
			environment: fixtureStore.environment,
			query: "architecture",
			dependencies: fixtureStore.dependencies,
			explain: true,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.sources[0]?.stage).not.toBe("map-route");
		expect(result.value.explain?.rejectedCount).toBeGreaterThan(0);
	});
});
