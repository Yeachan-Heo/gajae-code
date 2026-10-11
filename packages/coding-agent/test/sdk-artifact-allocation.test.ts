import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@gajae-code/ai";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { createAgentSession } from "@gajae-code/coding-agent/sdk";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { Snowflake } from "@gajae-code/utils";

type ArtifactAllocation = { id?: string; path?: string };
const tempDirs: string[] = [];

async function createFixture(destinationKind: "managed" | "explicit" = "managed") {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-sdk-artifact-allocation-${Snowflake.next()}-`));
	tempDirs.push(tempDir);
	const cwd = path.join(tempDir, "cwd");
	fs.mkdirSync(cwd, { recursive: true });
	const sessionManager =
		destinationKind === "managed"
			? SessionManager.create(cwd, SessionManager.managedDestination(cwd, tempDir))
			: SessionManager.create(cwd, SessionManager.explicitDestination(path.join(tempDir, "sessions")));
	const { session } = await createAgentSession({
		cwd,
		agentDir: tempDir,
		sessionManager,
		settings: Settings.isolated({ "async.enabled": false, "eval.py": false, "eval.js": true }),
		model: getBundledModel("openai", "gpt-4o-mini"),
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		toolNames: ["eval"],
		workspaceTree: {
			rootPath: cwd,
			rendered: ".",
			truncated: false,
			totalLines: 1,
			agentsMdFiles: [],
		},
	});
	return { tempDir, session, sessionManager };
}

describe("SDK output artifact allocation", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		for (const tempDir of tempDirs.splice(0)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("forwards the original allocation refusal through a real SDK tool execution", async () => {
		const fixture = await createFixture();
		const refusal = new Error("artifact allocation refused");
		const allocateArtifactPath = vi.spyOn(fixture.sessionManager, "allocateArtifactPath").mockRejectedValue(refusal);

		try {
			const evalTool = fixture.session.getToolByName("eval");
			if (!evalTool) throw new Error("Expected eval tool");
			const execution = evalTool.execute("allocation-refusal", {
				cells: [{ language: "js", code: "const value = 1;" }],
			});

			await expect(execution).rejects.toBe(refusal);
			expect(allocateArtifactPath).toHaveBeenCalledWith("eval");
		} finally {
			await fixture.session.dispose();
		}
	});

	it("keeps the existing stale-eval refusal when disposal starts during allocation", async () => {
		const fixture = await createFixture();
		const allocationStarted = Promise.withResolvers<ArtifactAllocation>();
		const releaseAllocation = Promise.withResolvers<void>();
		const allocateOriginal = fixture.sessionManager.allocateArtifactPath.bind(fixture.sessionManager);
		const allocateArtifactPath = vi
			.spyOn(fixture.sessionManager, "allocateArtifactPath")
			.mockImplementation(async toolType => {
				const allocation = await allocateOriginal(toolType);
				allocationStarted.resolve(allocation);
				await releaseAllocation.promise;
				return allocation;
			});
		let disposeSession: Promise<void> | undefined;

		try {
			const evalTool = fixture.session.getToolByName("eval");
			if (!evalTool) throw new Error("Expected eval tool");
			const execution = evalTool.execute("allocation-during-dispose", {
				cells: [{ language: "js", code: "const value = 1;" }],
			});
			const allocation = await allocationStarted.promise;
			if (!allocation.id) throw new Error("Expected an artifact allocation identity");
			expect(allocation.id).toMatch(/^\d+$/);

			disposeSession = fixture.session.dispose();
			releaseAllocation.resolve();
			await expect(execution).rejects.toThrow(
				"Python execution is unavailable while session disposal is in progress",
			);
			expect(allocateArtifactPath).toHaveBeenCalledWith("eval");
			await disposeSession;
		} finally {
			releaseAllocation.resolve();
			if (disposeSession) {
				await disposeSession;
			} else {
				await fixture.session.dispose();
			}
		}
	});

	it("passes through a real allocation identity and path for a successful SDK tool call", async () => {
		const fixture = await createFixture("explicit");
		const allocateOriginal = fixture.sessionManager.allocateArtifactPath.bind(fixture.sessionManager);
		let allocation: ArtifactAllocation | undefined;
		const allocateArtifactPath = vi
			.spyOn(fixture.sessionManager, "allocateArtifactPath")
			.mockImplementation(async toolType => {
				const allocated = await allocateOriginal(toolType);
				allocation = allocated;
				return allocated;
			});

		try {
			const evalTool = fixture.session.getToolByName("eval");
			if (!evalTool) throw new Error("Expected eval tool");
			const result = await evalTool.execute("allocation-success", {
				cells: [
					{
						language: "js",
						code: "console.log('sdk allocation control'); console.log('x'.repeat(60000));",
					},
				],
			});

			expect(allocateArtifactPath).toHaveBeenCalledWith("eval");
			if (!allocation?.id || !allocation.path) throw new Error("Expected a path-backed artifact allocation");
			expect(allocation.id).toMatch(/^\d+$/);
			const artifactsDir = fixture.sessionManager.getArtifactsDir();
			if (!artifactsDir) throw new Error("Expected a persisted session artifact directory");
			expect(path.resolve(path.dirname(allocation.path))).toBe(path.resolve(artifactsDir));
			expect(path.basename(allocation.path)).toBe(`${allocation.id}.eval.log`);
			expect(fs.readFileSync(allocation.path, "utf8")).toContain("sdk allocation control");
			expect(result.content.some(block => block.type === "text")).toBe(true);
		} finally {
			await fixture.session.dispose();
		}
	});
});
