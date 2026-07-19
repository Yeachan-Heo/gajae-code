import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	doctorFilesystemMemory,
	filesystemMemoryHeadingRange,
	getFilesystemMemoryDocument,
	parseFilesystemMemoryDocument,
	parseFilesystemMemoryMap,
	resolveFilesystemMemoryMapRoute,
	searchFilesystemMemory,
} from "../src/memory-filesystem";
import { FILESYSTEM_MEMORY_MAX_SELECTED_RESULTS } from "../src/memory-filesystem/retrieval";

const rootsToRemove: string[] = [];
async function fixtureRoot(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "filesystem-memory-retrieval-"));
	rootsToRemove.push(root);
	return root;
}
afterEach(async () => {
	await Promise.all(rootsToRemove.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

function markdown(title: string, body: string, volatility = "stable"): string {
	return `---\nversion: 1\ntitle: ${title}\ntags: ["architecture"]\nvolatility: ${volatility}\n---\n# ${title}\n${body}\n## Details\nMore detail\n`;
}

describe("filesystem MAP retrieval", () => {
	it("validates exact MAP versions and canonical targets, then returns sorted route targets", () => {
		expect(parseFilesystemMemoryMap('{"version":2,"routes":{}}').code).toBe("unknown_version");
		expect(parseFilesystemMemoryMap('{"version":1,"routes":{"route":["project:///not canonical.md"]}}').code).toBe(
			"invalid_path",
		);
		const map = parseFilesystemMemoryMap(
			'{"version":1,"routes":{"architecture":["project:///b.md","project:///a.md","project:///a.md"]}}',
		);
		expect(map).toMatchObject({
			code: "ok",
			value: { routes: { architecture: ["project:///a.md", "project:///b.md"] } },
		});
		if (map.code !== "ok") throw new Error("expected a valid MAP");
		expect(resolveFilesystemMemoryMapRoute(map.value, "architecture")).toMatchObject({
			code: "ok",
			value: { targets: ["project:///a.md", "project:///b.md"] },
		});
	});

	it("produces strict metadata, heading line ranges, and a content digest", () => {
		const parsed = parseFilesystemMemoryDocument(
			new TextEncoder().encode(markdown("Design", "Use a deterministic index.")),
		);
		expect(parsed.code).toBe("ok");
		if (parsed.code !== "ok") throw new Error("expected markdown to parse");
		expect(parsed.value.digest).toMatch(/^[a-f0-9]{64}$/);
		expect(parsed.value.headings).toEqual([
			{ level: 1, text: "Design", line: 7 },
			{ level: 2, text: "Details", line: 9 },
		]);
		expect(filesystemMemoryHeadingRange(parsed.value, parsed.value.headings[0]!)).toEqual([7, 11]);
		expect(parseFilesystemMemoryDocument(new TextEncoder().encode("---\nversion: 2\n---\n# Future\n")).code).toBe(
			"unknown_version",
		);
		expect(
			parseFilesystemMemoryDocument(new TextEncoder().encode("---\nversion: 1\nunknown: value\n---\n# Invalid\n"))
				.code,
		).toBe("invalid_path");
	});

	it("ranks deterministically, enforces result bounds, and exposes only logical volatile citations", async () => {
		const root = await fixtureRoot();
		await fs.writeFile(path.join(root, "a.md"), markdown("Architecture A", "architecture decision"));
		await fs.writeFile(path.join(root, "b.md"), markdown("Architecture B", "architecture decision"));
		await fs.writeFile(
			path.join(root, "volatile.md"),
			markdown("Volatile", "architecture current state", "volatile"),
		);
		await fs.writeFile(
			path.join(root, "archived.md"),
			`---\nversion: 1\ntitle: Archived\ntags: ["architecture"]\nvolatility: stable\nstatus: archived\n---\n# Archived\narchitecture old state\n`,
		);
		const result = await searchFilesystemMemory({ project: root }, { query: "architecture", limit: 4 });
		expect(result.code).toBe("ok");
		if (result.code !== "ok") throw new Error("expected retrieval");
		expect(result.value.results.map(entry => entry.citation.uri)).toEqual([
			"project:///a.md",
			"project:///b.md",
			"project:///volatile.md",
		]);
		const volatile = result.value.results.find(entry => entry.citation.uri === "project:///volatile.md");
		expect(volatile?.citation).toMatchObject({
			authority: "repository",
			volatility: "volatile",
			verificationRequired: true,
		});
		expect(JSON.stringify(result.value)).not.toContain(root);
		expect(result.value.results.some(entry => entry.citation.uri === "project:///archived.md")).toBe(false);
		expect(result.value.excluded).toContainEqual({ uri: "project:///archived.md", code: "excluded" });
		expect(
			(
				await searchFilesystemMemory(
					{ project: root },
					{ query: "architecture", limit: FILESYSTEM_MEMORY_MAX_SELECTED_RESULTS + 1 },
				)
			).code,
		).toBe("invalid_path");
	});

	it("prioritizes explicit MAP routes before lexical fallback", async () => {
		const root = await fixtureRoot();
		await fs.writeFile(path.join(root, "routed.md"), markdown("Runbook", "deployment procedure"));
		await fs.writeFile(path.join(root, "lexical.md"), markdown("Architecture", "architecture architecture"));
		const map = parseFilesystemMemoryMap('{"version":1,"routes":{"engineering.runbook":["project:///routed.md"]}}');
		if (map.code !== "ok") throw new Error("expected a valid MAP");
		const result = await searchFilesystemMemory(
			{ project: root },
			{ query: "architecture", map: map.value, routeId: "engineering.runbook", limit: 2 },
		);
		expect(result.code).toBe("ok");
		if (result.code !== "ok") throw new Error("expected retrieval");
		expect(result.value.results[0]?.citation.uri).toBe("project:///routed.md");
	});

	it("uses descriptor-backed get and refuses repository documents resembling credentials", async () => {
		const root = await fixtureRoot();
		await fs.writeFile(path.join(root, "safe.md"), markdown("Safe", "ordinary content"));
		await fs.writeFile(path.join(root, "secret.md"), markdown("Secret", "token: 1234567890"));
		expect((await getFilesystemMemoryDocument({ project: root }, "project:///safe.md")).code).toBe("ok");
		expect((await getFilesystemMemoryDocument({ project: root }, "project:///secret.md")).code).toBe("policy_denied");
		expect((await getFilesystemMemoryDocument({ project: root }, "project:///checkpoint.json")).code).toBe(
			"invalid_path",
		);
	});
	it("reports policy denial and secret-like repository content in doctor output", async () => {
		const root = await fixtureRoot();
		await fs.mkdir(path.join(root, "nested"));
		await fs.writeFile(path.join(root, "nested", "secret.md"), markdown("Secret", "token: 1234567890"));
		const report = await doctorFilesystemMemory({ project: root }, [
			{ scope: "global", available: false, reason: "policy_denied" },
			{ scope: "project", available: true, reason: null },
		]);
		expect(report.healthy).toBe(false);
		expect(report.findings).toContainEqual({ scope: "global", path: ".", code: "policy_denied" });
		expect(report.findings).toContainEqual({
			scope: "project",
			path: "nested/secret.md",
			code: "secret_like_shared_content",
		});
		expect(report.findings).toContainEqual({ scope: "project", path: "memory.yaml", code: "missing_map" });
	});
	it("treats intentionally uninitialized scopes as absent rather than unhealthy", async () => {
		const root = await fixtureRoot();
		await fs.writeFile(path.join(root, "memory.yaml"), '{"version":1,"routes":{}}\n');
		const report = await doctorFilesystemMemory({ "project-local": root }, [
			{ scope: "global", available: false, reason: "not_initialized" },
			{ scope: "project", available: false, reason: "not_initialized" },
			{ scope: "project-local", available: true, reason: null },
			{ scope: "session", available: false, reason: "identity_unavailable" },
		]);
		expect(report).toEqual({
			healthy: false,
			findings: [{ scope: "session", path: ".", code: "identity_unavailable" }],
		});
	});
});
