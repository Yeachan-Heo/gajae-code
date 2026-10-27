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

	it("admits new Task discovery from the committed moved directory", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-task-move-"));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "launch");
		const cwdB = path.join(cwdA, "project");
		const cwdC = path.join(tempDir, "unrelated");
		fs.mkdirSync(cwdB, { recursive: true });
		const sessionManager = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, tempDir));
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
			toolNames: ["task"],
		});
		const params = {
			agent: "missing-regression-agent",
			tasks: [
				{ id: "probe", description: "Check agent discovery", assignment: "Check the current committed workspace" },
			],
		};
		try {
			const before = session.getToolForExecution("task");
			if (!before) throw new Error("Expected the SDK Task tool");
			expect(textContent(await before.execute("before-move", params))).toContain("Unknown agent");
			const forbiddenBinding = await before.execute("forbidden-binding", {
				...params,
				tasks: [
					{
						...params.tasks[0],
						repositoryBinding: {
							schema: "gjc.repository_binding.v1",
							worktreeRoot: path.join(tempDir, "foreign"),
							commonDir: null,
						},
					},
				],
			});
			expect(textContent(forbiddenBinding)).toContain("repository binding rejected");
			await expect(sessionManager.moveTo(path.join(tempDir, "missing"))).rejects.toThrow();
			expect(sessionManager.getCwd()).toBe(cwdA);
			expect(textContent(await before.execute("rejected-move", params))).toContain("Unknown agent");
			await sessionManager.moveTo(cwdB);
			expect(sessionManager.getCwd()).toBe(cwdB);
			const after = session.getToolForExecution("task");
			if (!after) throw new Error("Expected Task after the committed move");
			const originalGetCwd = Object.getOwnPropertyDescriptor(sessionManager, "getCwd");
			Object.defineProperty(sessionManager, "getCwd", { configurable: true, value: () => cwdC });
			try {
				await expect(after.execute("uncommitted-cwd-drift", params)).rejects.toThrow(
					"session cwd changed outside a committed move",
				);
			} finally {
				if (originalGetCwd) Object.defineProperty(sessionManager, "getCwd", originalGetCwd);
				else Reflect.deleteProperty(sessionManager, "getCwd");
			}
			expect(textContent(await after.execute("after-move", params))).toContain("Unknown agent");
		} finally {
			await session.dispose();
		}
	});

	it("refreshes a warmed deferred Task after the committed move", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-deferred-task-move-"));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "launch");
		const cwdB = path.join(cwdA, "project");
		fs.mkdirSync(cwdB, { recursive: true });
		const sessionManager = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, tempDir));
		const { session } = await createAgentSession({
			cwd: cwdA,
			agentDir: tempDir,
			sessionManager,
			settings: Settings.isolated({ "async.enabled": false, "tools.discoveryMode": "all" }),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});
		const params = {
			agent: "missing-deferred-agent",
			tasks: [
				{
					id: "probe",
					description: "Check deferred agent discovery",
					assignment: "Check the current committed workspace",
				},
			],
		};
		try {
			const before = session.getToolForExecution("task");
			if (!before) throw new Error("Expected the deferred SDK Task tool");
			expect(textContent(await before.execute("before-move", params))).toContain("Unknown agent");
			await sessionManager.moveTo(cwdB);
			expect(sessionManager.getCwd()).toBe(cwdB);
			const after = session.getToolForExecution("task");
			if (!after) throw new Error("Expected Task after the committed move");
			expect(textContent(await after.execute("after-move", params))).toContain("Unknown agent");
		} finally {
			await session.dispose();
		}
	});

	it("keeps moved tool cwd and Task discovery through reset and reopen", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-move-reopen-"));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "launch");
		const cwdB = path.join(cwdA, "project");
		fs.mkdirSync(cwdB, { recursive: true });
		const settings = Settings.isolated({
			"async.enabled": false,
			"bash.autoBackground.enabled": false,
			"bashInterceptor.enabled": false,
		});
		const options = {
			agentDir: tempDir,
			settings,
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: ["bash", "task"],
		};
		const manager = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, tempDir));
		const { session } = await createAgentSession({ ...options, cwd: cwdA, sessionManager: manager });
		const params = {
			agent: "missing-reopen-agent",
			tasks: [{ id: "reopen", description: "Probe moved discovery", assignment: "Probe moved discovery" }],
		};
		let sessionFile: string;
		let sessionId: string;
		try {
			await manager.moveTo(cwdB);
			const task = session.getToolForExecution("task");
			if (!task) throw new Error("Expected moved Task");
			expect(textContent(await task.execute("warm-before-reset", params))).toContain("Unknown agent");
			const originalId = manager.getSessionId();
			expect(await session.newSession()).toBe(true);
			expect(manager.getSessionId()).not.toBe(originalId);
			expect(manager.getCwd()).toBe(cwdB);
			const afterReset = session.getToolForExecution("task");
			const bash = session.getToolForExecution("bash");
			if (!afterReset || !bash) throw new Error("Expected tools after reset");
			expect(textContent(await afterReset.execute("after-reset", params))).toContain("Unknown agent");
			expect(textContent(await bash.execute("pwd-after-reset", { command: "pwd" }))).toContain(cwdB);
			manager.appendMessage({ role: "user", content: "moved and reset", timestamp: Date.now() });
			await manager.ensureOnDisk();
			const file = manager.getSessionFile();
			if (!file) throw new Error("Expected persisted moved session");
			sessionFile = file;
			sessionId = manager.getSessionId();
		} finally {
			await session.dispose();
		}
		const reopened = await SessionManager.open(sessionFile, SessionManager.managedDestination(cwdB, tempDir));
		const restored = await createAgentSession({ ...options, cwd: cwdB, sessionManager: reopened });
		try {
			expect(reopened.getSessionId()).toBe(sessionId);
			expect(reopened.getCwd()).toBe(cwdB);
			const task = restored.session.getToolForExecution("task");
			const bash = restored.session.getToolForExecution("bash");
			if (!task || !bash) throw new Error("Expected reopened tools");
			expect(textContent(await task.execute("after-reopen", params))).toContain("Unknown agent");
			expect(textContent(await bash.execute("pwd-after-reopen", { command: "pwd" }))).toContain(cwdB);
		} finally {
			await restored.session.dispose();
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
