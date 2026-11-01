import { afterEach, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@gajae-code/ai";
import { createAgentSession } from "@gajae-code/coding-agent/sdk";
import { Settings } from "../src/config/settings";
import { ensureWorkflowSkillActivationState } from "../src/hooks/skill-state";
import type { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";
import * as activeState from "../src/skill-state/active-state";
import { createAssistantMessage } from "./helpers/agent-session-setup";

let session: AgentSession | undefined;
let authStorage: AuthStorage | undefined;
let cwd: string | undefined;

afterEach(async () => {
	vi.restoreAllMocks();
	await session?.dispose();
	authStorage?.close();
	if (cwd) await fs.rm(cwd, { recursive: true, force: true });
	session = undefined;
	authStorage = undefined;
	cwd = undefined;
});

async function resumeSession(workflow?: string, beforeRestore?: () => void): Promise<AgentSession> {
	cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-workflow-hydration-"));
	const manager = SessionManager.create(cwd, cwd);
	await manager.ensureOnDisk();
	manager.appendMessage({ role: "user", content: "Persist resumed fixture", timestamp: Date.now() });
	await manager.flush();
	if (workflow) await ensureWorkflowSkillActivationState({ cwd, skill: workflow, sessionId: manager.getSessionId() });
	const sessionFile = manager.getSessionFile();
	if (!sessionFile) throw new Error("Expected persisted session");
	await manager.close();
	const resumed = await SessionManager.open(sessionFile, cwd);
	expect(resumed.getSessionId()).toBe(manager.getSessionId());
	if (workflow) {
		expect(await activeState.readVisibleSkillActiveStateWithStatus(cwd, resumed.getSessionId())).toMatchObject({
			state: { active_skills: [expect.objectContaining({ skill: workflow, session_id: resumed.getSessionId() })] },
		});
	}
	authStorage = await AuthStorage.create(path.join(cwd, "auth.db"));
	authStorage.setRuntimeApiKey("openai", "test-key");
	beforeRestore?.();
	({ session } = await createAgentSession({
		cwd,
		agentDir: cwd,
		sessionManager: resumed,
		authStorage,
		settings: Settings.isolated({ "mcp.discoveryMode": "mcp-only", "compaction.enabled": false }),
		model: getBundledModel("openai", "gpt-4o-mini"),
		hasUI: false,
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
	}));
	return session;
}

async function ordinaryTurn(current: AgentSession): Promise<void> {
	const prompt = vi.spyOn(current.agent, "prompt").mockImplementation(async () => {
		const message = createAssistantMessage("Recorded.");
		current.agent.emitExternalEvent({ type: "turn_start" });
		current.agent.emitExternalEvent({ type: "message_end", message });
		current.agent.emitExternalEvent({ type: "agent_end", messages: [message] });
	});
	try {
		await current.prompt("Continue the current work.");
		await current.waitForIdle();
	} finally {
		prompt.mockRestore();
	}
}

for (const failure of ["rejected", "failed", "unresolved"] as const) {
	test(`ordinary SDK turn retries ${failure} resumed workflow hydration after storage recovery`, async () => {
		const stateRead = vi.spyOn(activeState, "readVisibleSkillActiveStateWithStatus");
		const current = await resumeSession("deep-interview", () => {
			if (failure === "rejected") stateRead.mockRejectedValueOnce(new Error("Transient state read failure"));
			else stateRead.mockResolvedValueOnce({ status: failure, state: null });
		});
		expect(current.getEffectiveActiveWorkflowSkillState()).toBeUndefined();
		expect(current.getActiveToolNames()).not.toContain("ask");
		expect(current.getDeepInterviewAskStage()).toBeUndefined();
		await ordinaryTurn(current);
		expect(current.getEffectiveActiveWorkflowSkillState()).toEqual({
			skill: "deep-interview",
			sessionId: current.sessionId,
		});
		expect(current.getActiveToolNames()).toContain("ask");
		expect(current.getDeepInterviewAskStage()).toBe("topology");
	}, 30_000);
}

test("confirmed empty restoration adds no hydration or terminal reads on ordinary turns", async () => {
	const stateRead = vi.spyOn(activeState, "readVisibleSkillActiveStateWithStatus");
	const current = await resumeSession();
	await expect(stateRead.mock.results.at(-1)?.value).resolves.toEqual({ status: "absent", state: null });
	stateRead.mockClear();
	const terminalRefresh = vi.spyOn(current, "refreshEffectiveActiveWorkflowSkillState");
	await ordinaryTurn(current);
	expect(stateRead).not.toHaveBeenCalled();
	expect(terminalRefresh).not.toHaveBeenCalled();
}, 30_000);

test("failed hydration confirmed empty stops retrying and does not resurrect a cleared workflow", async () => {
	const stateRead = vi.spyOn(activeState, "readVisibleSkillActiveStateWithStatus");
	const current = await resumeSession("deep-interview", () => {
		stateRead.mockRejectedValueOnce(new Error("Transient state read failure"));
	});
	await activeState.syncSkillActiveState({
		cwd: current.sessionManager.getCwd(),
		skill: "deep-interview",
		sessionId: current.sessionId,
		active: false,
	});
	stateRead.mockClear();
	await ordinaryTurn(current);
	expect(stateRead).toHaveBeenCalledTimes(1);
	expect(current.getEffectiveActiveWorkflowSkillState()).toBeUndefined();
	expect(current.getActiveToolNames()).not.toContain("ask");
	stateRead.mockClear();
	await ordinaryTurn(current);
	expect(stateRead).not.toHaveBeenCalled();
}, 30_000);

test("canonical resumed workflow is hydrated before the first ordinary turn", async () => {
	const current = await resumeSession("deep-interview");
	expect(current.getEffectiveActiveWorkflowSkillState()).toEqual({
		skill: "deep-interview",
		sessionId: current.sessionId,
	});
	expect(current.getActiveToolNames()).toContain("ask");
	expect(current.getDeepInterviewAskStage()).toBe("topology");
}, 30_000);

for (const boundary of ["abort", "new-session", "dispose"] as const) {
	test(`pending hydration cannot restore stale identity across ${boundary}`, async () => {
		const read = activeState.readVisibleSkillActiveStateWithStatus;
		const stateRead = vi.spyOn(activeState, "readVisibleSkillActiveStateWithStatus");
		const current = await resumeSession("deep-interview", () => {
			stateRead.mockRejectedValueOnce(new Error("Transient state read failure"));
		});
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		stateRead.mockImplementationOnce(async (...args) => {
			const result = await read(...args);
			started.resolve();
			await release.promise;
			return result;
		});
		const pending = current.refreshGjcSubskillTools();
		try {
			await started.promise;
			if (boundary === "abort") await current.abort();
			else if (boundary === "new-session") await current.newSession();
			else await current.dispose();
		} finally {
			release.resolve();
			await pending;
		}
		expect(current.getEffectiveActiveWorkflowSkillState()).toBeUndefined();
		expect(current.getDeepInterviewAskStage()).toBeUndefined();
		expect(current.getActiveToolNames()).not.toContain("ask");
	}, 30_000);
}

test("disposed sessions do not retry an unknown hydration", async () => {
	const stateRead = vi.spyOn(activeState, "readVisibleSkillActiveStateWithStatus");
	const current = await resumeSession("deep-interview", () => {
		stateRead.mockRejectedValueOnce(new Error("Transient state read failure"));
	});
	await current.dispose();
	stateRead.mockClear();
	await current.refreshEffectiveActiveWorkflowSkillState();
	expect(stateRead).not.toHaveBeenCalled();
	expect(current.getActiveToolNames()).not.toContain("ask");
}, 30_000);

test("closing admission does not retry unknown hydration before disposal settles", async () => {
	const stateRead = vi.spyOn(activeState, "readVisibleSkillActiveStateWithStatus");
	const current = await resumeSession("deep-interview", () => {
		stateRead.mockRejectedValueOnce(new Error("Transient state read failure"));
	});
	const closing = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	current.registerToolSessionCleanup(async () => {
		closing.resolve();
		await release.promise;
	});
	const disposal = current.dispose();
	try {
		await closing.promise;
		stateRead.mockClear();
		await current.refreshEffectiveActiveWorkflowSkillState();
		expect(stateRead).not.toHaveBeenCalled();
		expect(current.getActiveToolNames()).not.toContain("ask");
	} finally {
		release.resolve();
		await disposal;
	}
}, 30_000);
