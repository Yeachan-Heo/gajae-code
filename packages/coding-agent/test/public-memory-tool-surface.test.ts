import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { apply, initMemoryRoot, type MemoryEnvironment, propose } from "@gajae-code/memory-core";

import { getMemoryRootDir } from "@gajae-code/utils";
import { Settings } from "../src/config/settings";
import { BUILTIN_TOOLS, createTools, type ToolSession } from "../src/tools/index";

const repoRoot = path.resolve(import.meta.dir, "../../..");
const MEMORY_TOOL_NAMES = ["memory_recall", "memory_checkpoint", "memory_propose_write", "memory_forget"] as const;

type MemoryToolName = (typeof MEMORY_TOOL_NAMES)[number];

const publicGuidanceFiles = [
	"packages/coding-agent/README.md",
	"docs/codebase-overview.md",
	"docs/onboarding-packet.md",
	"docs/tools/read.md",
	"packages/coding-agent/src/prompts/tools/bash.md",
	"packages/coding-agent/src/prompts/tools/irc.md",
	"packages/coding-agent/src/prompts/tools/read.md",
	"packages/coding-agent/src/hindsight/backend.ts",
];

const publicDocsToolDir = path.join(repoRoot, "docs/tools");
const legacyMemoryPromptFiles = [
	"packages/coding-agent/src/prompts/tools/recall.md",
	"packages/coding-agent/src/prompts/tools/retain.md",
	"packages/coding-agent/src/prompts/tools/reflect.md",
];

function createToolSession(settings: Settings, cwd = repoRoot, sessionId: string | null = null): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		getSessionId: () => sessionId,
		settings,
		isToolDiscoveryEnabled: () => true,
		getSelectedDiscoveredToolNames: () => [],
		activateDiscoveredTools: async names => names,
	} as ToolSession;
}

function settingsForAgentDir(agentDir: string): Settings {
	const settings = Settings.isolated();
	Object.defineProperty(settings, "getAgentDir", { value: () => agentDir });
	return settings;
}

function memoryEnvironment(memoryRoot: string, sessionId: string | null = "surface-session"): MemoryEnvironment {
	return {
		memoryRoot,
		repository: null,
		sessionId,
		now: new Date("2026-07-29T00:00:00.000Z"),
		deterministic: true,
		asOf: "2026-07-29T00:00:00.000Z",
	};
}

interface MemoryFixture {
	agentDir: string;
	memoryRoot: string;
	settings: Settings;
}

async function withMemoryFixture<T>(run: (fixture: MemoryFixture) => Promise<T>): Promise<T> {
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-public-memory-tools-"));
	const settings = settingsForAgentDir(agentDir);
	const memoryRoot = getMemoryRootDir(agentDir);
	try {
		return await run({ agentDir, memoryRoot, settings });
	} finally {
		await fs.rm(agentDir, { recursive: true, force: true });
	}
}

async function canonicalSnapshot(memoryRoot: string): Promise<readonly unknown[]> {
	const files = await Promise.all(
		["MEMORY.md", "config.yaml", "projects/registry.yaml", "routes.yaml"].map(
			async relPath => [relPath, await fs.readFile(path.join(memoryRoot, relPath), "utf8")] as const,
		),
	);
	const directories = await Promise.all(
		["global", "projects", "sessions"].map(
			async relPath =>
				[
					relPath,
					// Staged proposal artifacts live beside canonical scopes by design;
					// this snapshot proves no canonical document changed.
					(await fs.readdir(path.join(memoryRoot, relPath))).filter(name => !name.startsWith("proposals-")).sort(),
				] as const,
		),
	);
	return [...files, ...directories];
}

describe("public memory tool surface", () => {
	it("exposes exactly four gated memory tools and no legacy helper names", async () => {
		const builtinMemoryNames = Object.keys(BUILTIN_TOOLS)
			.filter(name => name.startsWith("memory_"))
			.sort();
		expect(builtinMemoryNames).toEqual([...MEMORY_TOOL_NAMES].sort());
		expect(Object.keys(BUILTIN_TOOLS)).not.toEqual(expect.arrayContaining(["memory", "recall", "retain", "reflect"]));

		await withMemoryFixture(async ({ memoryRoot, settings }) => {
			const session = createToolSession(settings, repoRoot, "surface-session");
			// createTools also returns always-on essential tools, so compare only the
			// gated memory_* surface.
			const memoryNames = async (): Promise<readonly string[]> =>
				(await createTools(session, [...MEMORY_TOOL_NAMES]))
					.map(tool => tool.name)
					.filter(name => name.startsWith("memory_"))
					.sort();
			expect(await memoryNames()).toEqual([]);

			await initMemoryRoot(memoryEnvironment(memoryRoot));
			expect(await memoryNames()).toEqual([...MEMORY_TOOL_NAMES].sort());
		});
	});

	it("re-checks initialization at every tool ingress", async () => {
		const inputs: Readonly<Record<MemoryToolName, Readonly<Record<string, unknown>>>> = {
			memory_recall: { query: "surface check" },
			memory_checkpoint: { goal: "surface check", task: "gate", nextSteps: [] },
			memory_propose_write: { type: "note", content: "surface proposal" },
			memory_forget: { uri: "global://missing.md" },
		};

		await withMemoryFixture(async ({ agentDir, memoryRoot, settings }) => {
			const session = createToolSession(settings, repoRoot, "surface-session");
			for (const name of MEMORY_TOOL_NAMES) {
				await initMemoryRoot(memoryEnvironment(memoryRoot));
				const tool = (await createTools(session, [name]))[0];
				expect(tool).toBeDefined();
				await fs.rm(memoryRoot, { recursive: true, force: true });

				const result = await tool!.execute(`surface-${name}`, inputs[name]);
				expect(result.isError).toBe(true);
				expect(result.details).toMatchObject({
					schemaVersion: "gajae.memory.error.v1",
					code: "not-initialized",
					exitCode: 3,
				});
				expect(JSON.stringify(result)).not.toContain(agentDir);
			}
		});
	});

	it("covers the successful memory_forget ingress and tombstone route outcome", async () => {
		await withMemoryFixture(async ({ memoryRoot, settings }) => {
			const environment = memoryEnvironment(memoryRoot);
			await initMemoryRoot(environment);
			const uri = "global://constraints/surface-forget.md";
			const proposed = await propose(environment, {
				type: "note",
				content: "This canonical memory is disposable.",
				targetUri: uri,
			});
			expect(proposed.ok).toBe(true);
			if (!proposed.ok) return;

			const applied = await apply(environment, { proposalId: proposed.value.proposalId });
			expect(applied.ok).toBe(true);
			if (!applied.ok) return;

			const mapPath = path.join(memoryRoot, "MEMORY.md");
			const mapUri = "memory://global/constraints/surface-forget.md";
			expect(await fs.readFile(mapPath, "utf8")).toContain(mapUri);

			const session = createToolSession(settings, repoRoot, "surface-session");
			const tool = (await createTools(session, ["memory_forget"]))[0];
			expect(tool).toBeDefined();
			const result = await tool!.execute("surface-forget", { uri, reason: "surface cleanup" });
			expect(result.isError).not.toBe(true);
			expect(result.details).toMatchObject({
				schemaVersion: "gajae.memory.forget-receipt.v1",
				uri,
				forgotten: true,
				superseded: true,
				marker: "<!-- gajae: tombstone surface cleanup -->",
			});

			const tombstonePath = path.join(memoryRoot, "global", "constraints", "surface-forget.md");
			const tombstone = await fs.readFile(tombstonePath, "utf8");
			expect(tombstone).toContain('status: "superseded"');
			expect(tombstone).toContain("<!-- gajae: tombstone surface cleanup -->");
			expect(tombstone).not.toContain("verification: null");
			expect(await fs.readFile(mapPath, "utf8")).not.toContain(mapUri);
		});
	});

	it("keeps memory_propose_write proposal-only for canonical documents", async () => {
		await withMemoryFixture(async ({ memoryRoot, settings }) => {
			await initMemoryRoot(memoryEnvironment(memoryRoot));
			const before = await canonicalSnapshot(memoryRoot);
			const session = createToolSession(settings, repoRoot, "surface-session");
			const tool = (await createTools(session, ["memory_propose_write"]))[0];
			expect(tool).toBeDefined();

			const result = await tool!.execute("surface-proposal", {
				type: "note",
				content: "A proposal must not alter canonical memory.",
			});
			expect(result.isError).not.toBe(true);
			expect(result.details).toMatchObject({ schemaVersion: "gajae.memory.write-proposal.v1" });
			expect(await canonicalSnapshot(memoryRoot)).toEqual(before);
		});
	});

	it("does not register or publish legacy Hindsight helpers through public discovery", async () => {
		const tools = await createTools(createToolSession(Settings.isolated({ "memory.backend": "hindsight" })), [
			"recall",
			"retain",
			"reflect",
		]);
		expect(tools.map(tool => tool.name)).not.toEqual(expect.arrayContaining(["recall", "retain", "reflect"]));

		const docsToolFiles = await fs.readdir(publicDocsToolDir);
		expect(docsToolFiles).not.toEqual(expect.arrayContaining(["recall.md", "retain.md", "reflect.md"]));
	});

	it("does not document public memory tool usage in public guidance", async () => {
		const offenders: string[] = [];
		const publicToolUsagePatterns = [
			/memory:\/\//i,
			/\buse\s+`?(?:recall|retain|reflect)`?/i,
			/\bexposes?\s+`?(?:recall|retain|reflect)`?,\s+`?(?:recall|retain|reflect)`?,\s+(?:and\s+)?`?(?:reflect|recall|retain)`?/i,
		];
		for (const relativePath of publicGuidanceFiles) {
			const content = await fs.readFile(path.join(repoRoot, relativePath), "utf8");
			if (publicToolUsagePatterns.some(pattern => pattern.test(content))) {
				offenders.push(relativePath);
			}
		}
		expect(offenders).toEqual([]);
	});

	it("keeps legacy Hindsight prompts out of the public guidance set", async () => {
		for (const relativePath of legacyMemoryPromptFiles) {
			const content = await fs.readFile(path.join(repoRoot, relativePath), "utf8");
			expect(content).toContain("Compatibility-only legacy Hindsight helper");
			expect(content).toContain("not part of the public gajae-code coding harness tool surface");
		}
	});
});
