import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@gajae-code/ai";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { createAgentSession } from "@gajae-code/coding-agent/sdk";
import { ArtifactManager } from "@gajae-code/coding-agent/session/artifacts";
import { SessionManager, SessionManagerTestHooks } from "@gajae-code/coding-agent/session/session-manager";
import { Snowflake } from "@gajae-code/utils";
import { injectManagedAppendPreCommit } from "./session-manager/managed-failure-injection";

function textContent(result: { content?: Array<{ type: string; text?: string }> }): string {
	return (
		result.content
			?.filter(
				(block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string",
			)
			.map(block => block.text)
			.join("\n") ?? ""
	);
}

describe("createAgentSession cwd after /move", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const tempDir of tempDirs.splice(0)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("restores a genuine snapshot after a managed SDK move rolls back its physical publication", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-move-rollback-"));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "cwd-a");
		const cwdB = path.join(tempDir, "cwd-b");
		fs.mkdirSync(cwdA);
		fs.mkdirSync(cwdB);
		const sessionManager = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, tempDir));
		const borrowed = new ArtifactManager(path.join(tempDir, "caller-artifacts"));
		sessionManager.appendMessage({ role: "user", content: "before failed move", timestamp: 1 });
		await sessionManager.ensureOnDisk();
		sessionManager.adoptArtifactManager(borrowed);
		const { session } = await createAgentSession({
			cwd: cwdA,
			agentDir: tempDir,
			sessionManager,
			settings: Settings.isolated({ "async.enabled": false }),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: [],
		});
		const snapshot = await sessionManager.captureRollbackState();
		let failed = false;
		const injection = injectManagedAppendPreCommit((_file, data) => {
			if (!failed && Buffer.from(data).toString("utf8").includes(cwdB)) {
				failed = true;
				return { ok: false, code: "io_error" };
			}
			return "passthrough";
		});
		try {
			await expect(sessionManager.moveTo(cwdB)).rejects.toThrow("io_error");
			injection.assertHit();
			injection.restore();
			expect(sessionManager.getCwd()).toBe(cwdA);
			expect(sessionManager.getSessionFile()).toBe(snapshot.sessionFile);
			const physicalIdentity = sessionManager.captureState().managedPersistExpectedIdentity;
			await sessionManager.restoreRollbackState(snapshot);
			expect(sessionManager.captureState().managedPersistExpectedIdentity).toEqual(physicalIdentity);
			expect(sessionManager.getSessionId()).toBe(snapshot.sessionId);
			expect(sessionManager.getArtifactManager()).toBe(borrowed);
			const artifactId = await sessionManager.saveArtifact("after legitimate rollback", "sdk");
			expect(await borrowed.readRange(artifactId!)).toBe("after legitimate rollback");
			sessionManager.appendMessage({ role: "user", content: "managed identity still writable", timestamp: 2 });
			await sessionManager.flush();
			expect(await Bun.file(snapshot.sessionFile!).text()).toContain("managed identity still writable");
		} finally {
			injection.restore();
			await session.dispose();
		}
		const callerId = await borrowed.save("caller retains ownership", "sdk");
		expect(await borrowed.readRange(callerId)).toBe("caller retains ownership");
	});

	it("restores caller-owned manager authority through the public SDK switch failure path", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-switch-rollback-"));
		tempDirs.push(tempDir);
		const sessionManager = SessionManager.create(tempDir, SessionManager.managedDestination(tempDir, tempDir));
		const target = SessionManager.create(tempDir, SessionManager.managedDestination(tempDir, tempDir));
		sessionManager.appendMessage({ role: "user", content: "SDK predecessor", timestamp: 1 });
		await sessionManager.ensureOnDisk();
		target.appendMessage({ role: "user", content: "SDK successor", timestamp: 2 });
		await target.ensureOnDisk();
		const targetFile = target.getSessionFile();
		if (!targetFile) throw new Error("Expected switch target");
		await target.close();
		const borrowed = new ArtifactManager(path.join(tempDir, "caller-artifacts"));
		sessionManager.adoptArtifactManager(borrowed);
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager,
			settings: Settings.isolated({ "async.enabled": false }),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: [],
		});
		const originalId = sessionManager.getSessionId();
		const originalFile = sessionManager.getSessionFile();
		const failure = new Error("SDK adoption rejected before commit");
		SessionManagerTestHooks.beforeManagedSwitchIdentity = () => {
			throw failure;
		};
		try {
			await expect(session.switchSession(targetFile)).rejects.toThrow(failure.message);
			expect(sessionManager.getSessionId()).toBe(originalId);
			expect(sessionManager.getSessionFile()).toBe(originalFile);
			expect(sessionManager.getArtifactManager()).toBe(borrowed);
			const id = await sessionManager.saveArtifact("SDK rollback works", "sdk");
			expect(await borrowed.readRange(id!)).toBe("SDK rollback works");
		} finally {
			SessionManagerTestHooks.beforeManagedSwitchIdentity = undefined;
			await session.dispose();
		}
	});

	it("runs tools from the moved session directory", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-sdk-move-cwd-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "cwd-a");
		const cwdB = path.join(tempDir, "cwd-b");
		fs.mkdirSync(cwdA, { recursive: true });
		fs.mkdirSync(cwdB, { recursive: true });

		const sessionManager = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, tempDir));
		const { session } = await createAgentSession({
			cwd: cwdA,
			agentDir: tempDir,
			sessionManager,
			settings: Settings.isolated({
				"async.enabled": false,
				"bash.autoBackground.enabled": false,
				"bashInterceptor.enabled": false,
			}),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: ["bash"],
		});

		try {
			await sessionManager.moveTo(cwdB);

			const bashTool = session.getToolByName("bash");
			if (!bashTool) throw new Error("Expected bash tool");
			const result = await bashTool.execute("pwd-after-move", { command: "pwd" });

			expect(textContent(result)).toContain(cwdB);
		} finally {
			await session.dispose();
		}
	});
});
