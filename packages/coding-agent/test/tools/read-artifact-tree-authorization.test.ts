import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolContext } from "@gajae-code/agent-core";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { InternalUrlRouter } from "@gajae-code/coding-agent/internal-urls";
import { AgentRegistry } from "@gajae-code/coding-agent/registry/agent-registry";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import type { ToolSession } from "@gajae-code/coding-agent/tools";
import { ReadTool } from "@gajae-code/coding-agent/tools/read";

// Tool-boundary regression coverage for gajae-code#3302.
//
// The router-only test (`test/internal-urls/agent-artifact-scope.test.ts`)
// hand-builds a `ResolveContext` and therefore never exercises the runtime
// wiring that produces one. This file builds real `ToolSession` objects the
// same way `sdk/session.ts` does — `getArtifactsDir` from the session's own
// `SessionManager`, `getAuthorizedArtifactsDirs` from
// `sessionManager.getArtifactManager()?.dir` — and drives them through the
// actual `ReadTool`, so a regression in that wiring (the bug reported in
// #3302) fails here even if the router-level scoping logic is untouched.

function toolSessionFor(sessionManager: SessionManager, cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		hasEditTool: false,
		getSessionFile: () => sessionManager.getSessionFile() ?? null,
		getSessionSpawns: () => "*",
		getArtifactsDir: () => sessionManager.getArtifactsDir(),
		getArtifactManager: () => sessionManager.getArtifactManager(),
		getAuthorizedArtifactsDirs: () => {
			const manager = sessionManager.getArtifactManager();
			return manager ? [manager.dir] : [];
		},
		settings: Settings.isolated(),
	} as unknown as ToolSession;
}

function toolContext(): AgentToolContext {
	return {
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated(),
		toolNames: ["read"],
		isIdle: () => true,
		hasQueuedMessages: () => false,
		abort: () => {},
	} as unknown as AgentToolContext;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(block => block.type === "text")
		.map(block => block.text ?? "")
		.join("\n");
}

async function writeAgentOutput(artifactsDir: string, id: string, content: string): Promise<void> {
	fs.mkdirSync(artifactsDir, { recursive: true });
	const outputPath = path.join(artifactsDir, `${id}.md`);
	fs.writeFileSync(outputPath, content);
	fs.writeFileSync(
		`${outputPath}.meta.json`,
		JSON.stringify({
			id,
			kind: "agent-output",
			sizeBytes: Buffer.byteLength(content, "utf8"),
			lineCount: content.split("\n").length,
			sha256: createHash("sha256").update(content).digest("hex"),
			createdAt: "2026-06-05T00:00:00.000Z",
		}),
	);
}

async function readInternalUrl(session: ToolSession, url: string) {
	const tool = new ReadTool(session);
	return tool.execute("read-artifact-tree", { path: url }, undefined, undefined, toolContext());
}

let tempDir: string;

beforeEach(() => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "read-artifact-tree-authorization-"));
	AgentRegistry.resetGlobalForTests();
	InternalUrlRouter.resetForTests();
});

afterEach(() => {
	AgentRegistry.resetGlobalForTests();
	InternalUrlRouter.resetForTests();
	fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("ReadTool artifact:// / agent:// tree authorization (tool boundary)", () => {
	it("lets a same-tree detached child read a verified agent-output the parent can read", async () => {
		const parentManager = SessionManager.create(tempDir, SessionManager.explicitDestination(tempDir));
		const parentArtifactManager = parentManager.getArtifactManager()!;
		await writeAgentOutput(parentArtifactManager.dir, "0-Parent", "parent verified output");

		const parentSession = toolSessionFor(parentManager, tempDir);
		await expect(readInternalUrl(parentSession, "agent://0-Parent")).resolves.toBeDefined();
		const parentResult = await readInternalUrl(parentSession, "agent://0-Parent");
		expect(textOf(parentResult)).toContain("parent verified output");

		// Detached child: adopts the parent's ArtifactManager, exactly as
		// `task/executor.ts` does for subagents (`options.parentArtifactManager`).
		const childManager = SessionManager.inMemory(tempDir);
		childManager.adoptArtifactManager(parentArtifactManager);
		const childSession = toolSessionFor(childManager, tempDir);

		const childResult = await readInternalUrl(childSession, "agent://0-Parent");
		expect(textOf(childResult)).toContain("parent verified output");
	});

	it("lets sibling subagents in the same tree read each other's agent-output", async () => {
		const parentManager = SessionManager.create(tempDir, SessionManager.explicitDestination(tempDir));
		const parentArtifactManager = parentManager.getArtifactManager()!;

		const siblingA = SessionManager.inMemory(tempDir);
		siblingA.adoptArtifactManager(parentArtifactManager);
		const siblingB = SessionManager.inMemory(tempDir);
		siblingB.adoptArtifactManager(parentArtifactManager);

		await writeAgentOutput(parentArtifactManager.dir, "0-SiblingA", "sibling A output");

		const siblingBSession = toolSessionFor(siblingB, tempDir);
		const result = await readInternalUrl(siblingBSession, "agent://0-SiblingA");
		expect(textOf(result)).toContain("sibling A output");
	});

	it("lets a resumed detached child (fresh SessionManager instance, same adoption) keep reading tree output", async () => {
		const parentManager = SessionManager.create(tempDir, SessionManager.explicitDestination(tempDir));
		const parentArtifactManager = parentManager.getArtifactManager()!;
		await writeAgentOutput(parentArtifactManager.dir, "0-Parent", "still readable after resume");

		// Simulates a resumed child: a brand new `SessionManager`/`ToolSession`
		// object re-adopting the same retained `ArtifactManager` (see
		// `task/index.ts`, which re-derives `parentArtifactManager` on resume).
		const resumedChildManager = SessionManager.inMemory(tempDir);
		resumedChildManager.adoptArtifactManager(parentArtifactManager);
		const resumedChildSession = toolSessionFor(resumedChildManager, tempDir);

		const result = await readInternalUrl(resumedChildSession, "agent://0-Parent");
		expect(textOf(result)).toContain("still readable after resume");
	});

	it("denies a session outside the tree even when a same-named id exists in both", async () => {
		const parentManager = SessionManager.create(tempDir, SessionManager.explicitDestination(tempDir));
		const parentArtifactManager = parentManager.getArtifactManager()!;
		await writeAgentOutput(parentArtifactManager.dir, "0-Secret", "tree-only secret");

		const unrelatedDir = path.join(tempDir, "unrelated");
		fs.mkdirSync(unrelatedDir, { recursive: true });
		const unrelatedManager = SessionManager.create(unrelatedDir, SessionManager.explicitDestination(unrelatedDir));
		await writeAgentOutput(unrelatedManager.getArtifactManager()!.dir, "0-Other", "unrelated content");

		AgentRegistry.global().register({
			id: "live-unrelated",
			displayName: "live-unrelated",
			kind: "main",
			session: null,
			sessionFile: `${unrelatedManager.getArtifactManager()!.dir}.jsonl`,
			status: "running",
		});

		const unrelatedSession = toolSessionFor(unrelatedManager, unrelatedDir);
		await expect(readInternalUrl(unrelatedSession, "agent://0-Secret")).rejects.toThrow("agent://0-Secret not found");
	});

	it("fails closed with a distinct error when no session is authorized at all", async () => {
		const orphanManager = SessionManager.inMemory(tempDir);
		const orphanSession = toolSessionFor(orphanManager, tempDir);
		await expect(readInternalUrl(orphanSession, "agent://0-Anything")).rejects.toThrow(
			"No session - agent outputs unavailable",
		);
	});

	it("fails closed and distinctly on a missing metadata sidecar even inside an authorized tree", async () => {
		const parentManager = SessionManager.create(tempDir, SessionManager.explicitDestination(tempDir));
		const parentArtifactManager = parentManager.getArtifactManager()!;
		fs.mkdirSync(parentArtifactManager.dir, { recursive: true });
		fs.writeFileSync(path.join(parentArtifactManager.dir, "0-NoMeta.md"), "sidecar-free content");

		const childManager = SessionManager.inMemory(tempDir);
		childManager.adoptArtifactManager(parentArtifactManager);
		const childSession = toolSessionFor(childManager, tempDir);

		await expect(readInternalUrl(childSession, "agent://0-NoMeta")).rejects.toThrow(
			"agent://0-NoMeta missing metadata",
		);
	});

	it("fails closed and distinctly when the sidecar exists but content integrity does not match", async () => {
		const parentManager = SessionManager.create(tempDir, SessionManager.explicitDestination(tempDir));
		const parentArtifactManager = parentManager.getArtifactManager()!;
		await writeAgentOutput(parentArtifactManager.dir, "0-Tampered", "original content");
		// Tamper with the content after the metadata sidecar was written.
		fs.writeFileSync(path.join(parentArtifactManager.dir, "0-Tampered.md"), "tampered content");

		const childManager = SessionManager.inMemory(tempDir);
		childManager.adoptArtifactManager(parentArtifactManager);
		const childSession = toolSessionFor(childManager, tempDir);

		await expect(readInternalUrl(childSession, "agent://0-Tampered")).rejects.toThrow();
	});
});
