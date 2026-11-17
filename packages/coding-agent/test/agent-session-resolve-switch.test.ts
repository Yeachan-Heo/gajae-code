import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import type { ToolChoice } from "@gajae-code/ai";
import { getBundledModel } from "@gajae-code/ai";
import { AsyncJobManager } from "@gajae-code/coding-agent/async/job-manager";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import type { ToolSession } from "@gajae-code/coding-agent/tools";
import { queueResolveHandler, ResolveTool } from "@gajae-code/coding-agent/tools/resolve";
import { TempDir } from "@gajae-code/utils";

const forcedResolve = { type: "tool", name: "resolve" } as const satisfies ToolChoice;
const tempDirs: TempDir[] = [];

function bindResolveInstall(session: AgentSession): ToolSession {
	return {
		getToolChoiceQueue: () => session.toolChoiceQueue,
		buildToolChoiceResult: () => ({
			choice: forcedResolve,
			exactNamed: true,
			resolved: undefined,
		}),
		sendCustomMessage: async () => {},
		peekStandingResolveHandler: () => session.peekStandingResolveHandler(),
		setStandingResolveHandler: (handler: ((input: unknown) => Promise<unknown> | unknown) | null) =>
			session.setStandingResolveHandler(handler),
		peekQueueInvoker: () => session.peekQueueInvoker(),
	} as unknown as ToolSession;
}

async function openSession(manager: SessionManager, modelRegistry: ModelRegistry): Promise<AgentSession> {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled model");
	const session = new AgentSession({
		agent: new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		}),
		sessionManager: manager,
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry,
		agentId: "resolve-switch",
	});
	session.agent.setTools([new ResolveTool(session as unknown as ToolSession)]);
	return session;
}

describe("AgentSession resolve dispatch across switchSession", () => {
	const sessions: AgentSession[] = [];
	const authStores: AuthStorage[] = [];

	afterEach(async () => {
		for (const session of sessions.splice(0)) {
			await session.dispose();
		}
		AsyncJobManager.setInstance(undefined);
		for (const auth of authStores.splice(0)) auth.close();
		for (const dir of tempDirs.splice(0)) {
			try {
				await dir.remove();
			} catch {
				// Best-effort fixture cleanup.
			}
		}
	});

	async function fixture() {
		const tempDir = TempDir.createSync("@gjc-resolve-switch-");
		tempDirs.push(tempDir);
		const cwd = tempDir.path();
		const authStorage = await AuthStorage.create(path.join(cwd, "auth.db"));
		authStores.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(cwd, "models.yml"));
		return { cwd, modelRegistry };
	}

	function installPreview(session: AgentSession, markerPath: string) {
		queueResolveHandler(bindResolveInstall(session), {
			label: "preview",
			sourceToolName: "ast_edit",
			apply: async () => {
				fs.writeFileSync(markerPath, session.sessionId);
				return { content: [{ type: "text", text: "applied" }] };
			},
		});
	}

	it("cross-session resolve apply leaves the previous preview unapplied", async () => {
		const { cwd, modelRegistry } = await fixture();
		const markerPath = path.join(cwd, "resolve-apply-marker.txt");
		const sessionA = SessionManager.create(cwd, cwd);
		sessionA.appendMessage({ role: "user", content: "A", timestamp: 1 });
		await sessionA.ensureOnDisk();
		const sessionB = SessionManager.create(cwd, cwd);
		sessionB.appendMessage({ role: "user", content: "B", timestamp: 1 });
		await sessionB.ensureOnDisk();
		const sessionBFile = sessionB.getSessionFile();
		if (!sessionBFile) throw new Error("Expected session B file");
		await sessionB.close();

		const session = await openSession(sessionA, modelRegistry);
		sessions.push(session);
		installPreview(session, markerPath);
		expect(session.toolChoiceQueue.inspect()).toEqual(["pending-action:ast_edit"]);
		expect(session.toolChoiceQueue.nextToolChoice()).toEqual(forcedResolve);

		expect(await session.switchSession(sessionBFile)).toBe(true);
		expect(session.nextToolChoice()).toBeUndefined();
		expect(session.toolChoiceQueue.inspect().some(label => label.includes("pending-action"))).toBe(false);
		expect(session.peekStandingResolveHandler()).toBeUndefined();

		const tool = new ResolveTool(session as unknown as ToolSession);
		await expect(tool.execute("call-apply", { action: "apply", reason: "apply previous preview" })).rejects.toThrow(
			"No pending action to resolve. Nothing to apply or discard.",
		);
		expect(fs.existsSync(markerPath)).toBe(false);
	}, 30_000);

	it("same-session resolve apply still runs", async () => {
		const { cwd, modelRegistry } = await fixture();
		const markerPath = path.join(cwd, "resolve-apply-marker.txt");
		const manager = SessionManager.create(cwd, cwd);
		manager.appendMessage({ role: "user", content: "A", timestamp: 1 });
		await manager.ensureOnDisk();
		const session = await openSession(manager, modelRegistry);
		sessions.push(session);
		installPreview(session, markerPath);

		const tool = new ResolveTool(session as unknown as ToolSession);
		const result = await tool.execute("call-apply", { action: "apply", reason: "apply current preview" });
		expect(result.details?.sourceToolName).toBe("ast_edit");
		expect(fs.readFileSync(markerPath, "utf8")).toBe(session.sessionId);
	}, 30_000);

	it("same-file reload keeps a pending resolve apply", async () => {
		const { cwd, modelRegistry } = await fixture();
		const markerPath = path.join(cwd, "resolve-apply-marker.txt");
		const manager = SessionManager.create(cwd, cwd);
		manager.appendMessage({ role: "user", content: "A", timestamp: 1 });
		await manager.ensureOnDisk();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		const session = await openSession(manager, modelRegistry);
		sessions.push(session);
		installPreview(session, markerPath);

		expect(await session.switchSession(sessionFile)).toBe(true);
		const tool = new ResolveTool(session as unknown as ToolSession);
		const result = await tool.execute("call-apply", { action: "apply", reason: "apply after reload" });
		expect(result.details?.label).toBe("preview");
		expect(fs.readFileSync(markerPath, "utf8")).toBe(session.sessionId);
	}, 30_000);

	it("resolve installed after a session switch still runs", async () => {
		const { cwd, modelRegistry } = await fixture();
		const markerPath = path.join(cwd, "resolve-apply-marker.txt");
		const sessionA = SessionManager.create(cwd, cwd);
		sessionA.appendMessage({ role: "user", content: "A", timestamp: 1 });
		await sessionA.ensureOnDisk();
		const sessionB = SessionManager.create(cwd, cwd);
		sessionB.appendMessage({ role: "user", content: "B", timestamp: 1 });
		await sessionB.ensureOnDisk();
		const sessionBFile = sessionB.getSessionFile();
		if (!sessionBFile) throw new Error("Expected session B file");
		await sessionB.close();

		const session = await openSession(sessionA, modelRegistry);
		sessions.push(session);
		expect(await session.switchSession(sessionBFile)).toBe(true);
		installPreview(session, markerPath);
		const tool = new ResolveTool(session as unknown as ToolSession);
		const result = await tool.execute("call-apply", { action: "apply", reason: "apply successor preview" });
		expect(result.details?.action).toBe("apply");
		expect(fs.readFileSync(markerPath, "utf8")).toBe(session.sessionId);
	}, 30_000);
});
