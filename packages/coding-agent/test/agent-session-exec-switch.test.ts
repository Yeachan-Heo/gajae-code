import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai";
import { AsyncJobManager } from "@gajae-code/coding-agent/async/job-manager";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { TempDir } from "@gajae-code/utils";

const tempDirs: TempDir[] = [];

function bashResult(output: string) {
	return {
		output,
		exitCode: 0,
		cancelled: false,
		truncated: false,
		totalLines: 1,
		totalBytes: output.length,
		outputLines: 1,
		outputBytes: output.length,
	};
}

function pythonResult(output: string) {
	return {
		output,
		exitCode: 0,
		cancelled: false,
		truncated: false,
		totalLines: 1,
		totalBytes: output.length,
		outputLines: 1,
		outputBytes: output.length,
		displayOutputs: [],
		stdinRequested: false,
	};
}

function executionText(message: { role: string }): string {
	if (message.role === "bashExecution" && "command" in message && typeof message.command === "string") {
		const output = "output" in message && typeof message.output === "string" ? message.output : "";
		return `${message.command}\n${output}`;
	}
	if (message.role === "pythonExecution" && "code" in message && typeof message.code === "string") {
		const output = "output" in message && typeof message.output === "string" ? message.output : "";
		return `${message.code}\n${output}`;
	}
	return "";
}

function deferWhileStreaming(session: AgentSession, record: () => void): void {
	Object.defineProperty(session, "isStreaming", { configurable: true, get: () => true });
	try {
		record();
	} finally {
		Reflect.deleteProperty(session, "isStreaming");
	}
}

async function sessionText(session: AgentSession): Promise<string> {
	const file = session.sessionManager.getSessionFile();
	if (!file) throw new Error("Expected session file");
	await session.sessionManager.flush();
	return Bun.file(file).text();
}

async function flushByNextPrompt(session: AgentSession): Promise<void> {
	try {
		await session.prompt("flush-deferred-exec");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (!message.includes("No credentials found")) throw error;
	}
}

async function openSession(manager: SessionManager, modelRegistry: ModelRegistry) {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled model");
	return new AgentSession({
		agent: new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		}),
		sessionManager: manager,
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry,
		agentId: "exec-queue-switch",
	});
}

describe("AgentSession deferred execution across switchSession", () => {
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
		const tempDir = TempDir.createSync("@gjc-exec-switch-");
		tempDirs.push(tempDir);
		const cwd = tempDir.path();
		const authStorage = await AuthStorage.create(path.join(cwd, "auth.db"));
		authStores.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(cwd, "models.yml"));
		return { cwd, modelRegistry };
	}

	it("switchSession to another file leaves deferred bash and python out of that session", async () => {
		const { cwd, modelRegistry } = await fixture();
		const sessionA = SessionManager.create(cwd, cwd);
		sessionA.appendMessage({ role: "user", content: "A-1", timestamp: 1 });
		await sessionA.ensureOnDisk();

		const sessionB = SessionManager.create(cwd, cwd);
		sessionB.appendMessage({ role: "user", content: "B-1", timestamp: 1 });
		await sessionB.ensureOnDisk();
		const sessionBFile = sessionB.getSessionFile();
		if (!sessionBFile) throw new Error("Expected session B file");
		await sessionB.close();

		const session = await openSession(sessionA, modelRegistry);
		sessions.push(session);
		let bashPersisted = false;
		let pythonPersisted = false;
		deferWhileStreaming(session, () => {
			session.recordBashResult("echo deferred-bash-marker", bashResult("deferred-bash-out"), {
				onPersisted: () => {
					bashPersisted = true;
				},
			});
			session.recordPythonResult("print('deferred-python-marker')", pythonResult("deferred-python-out"), {
				onPersisted: () => {
					pythonPersisted = true;
				},
			});
		});
		expect(session.hasPendingBashMessages).toBe(true);
		expect(session.hasPendingPythonMessages).toBe(true);

		expect(await session.switchSession(sessionBFile)).toBe(true);
		await flushByNextPrompt(session);

		const live = session.agent.state.messages.map(message => executionText(message)).join("\n");
		const stored = await sessionText(session);
		expect(live.includes("deferred-bash-marker")).toBe(false);
		expect(live.includes("deferred-python-marker")).toBe(false);
		expect(stored.includes("deferred-bash-marker")).toBe(false);
		expect(stored.includes("deferred-python-marker")).toBe(false);
		expect(bashPersisted).toBe(false);
		expect(pythonPersisted).toBe(false);
		expect(session.hasPendingBashMessages).toBe(false);
		expect(session.hasPendingPythonMessages).toBe(false);
	}, 30_000);

	it("keeps deferred bash and python when the next prompt flushes the same session", async () => {
		const { cwd, modelRegistry } = await fixture();
		const manager = SessionManager.create(cwd, cwd);
		manager.appendMessage({ role: "user", content: "S-1", timestamp: 1 });
		await manager.ensureOnDisk();
		const session = await openSession(manager, modelRegistry);
		sessions.push(session);
		let bashPersisted = false;
		let pythonPersisted = false;
		deferWhileStreaming(session, () => {
			session.recordBashResult("echo same-session-bash", bashResult("same-session-bash-out"), {
				onPersisted: () => {
					bashPersisted = true;
				},
			});
			session.recordPythonResult("print('same-session-python')", pythonResult("same-session-python-out"), {
				onPersisted: () => {
					pythonPersisted = true;
				},
			});
		});
		expect(session.hasPendingBashMessages).toBe(true);
		expect(session.hasPendingPythonMessages).toBe(true);

		await flushByNextPrompt(session);

		const live = session.agent.state.messages.map(message => executionText(message)).join("\n");
		const stored = await sessionText(session);
		expect(live).toContain("echo same-session-bash");
		expect(live).toContain("print('same-session-python')");
		expect(stored).toContain("echo same-session-bash");
		expect(stored).toContain("print('same-session-python')");
		expect(bashPersisted).toBe(true);
		expect(pythonPersisted).toBe(true);
		expect(session.hasPendingBashMessages).toBe(false);
		expect(session.hasPendingPythonMessages).toBe(false);
	}, 30_000);

	it("keeps deferred bash after a switch to the same session file", async () => {
		const { cwd, modelRegistry } = await fixture();
		const manager = SessionManager.create(cwd, cwd);
		manager.appendMessage({ role: "user", content: "S-1", timestamp: 1 });
		await manager.ensureOnDisk();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		const session = await openSession(manager, modelRegistry);
		sessions.push(session);
		deferWhileStreaming(session, () => {
			session.recordBashResult("echo same-file-bash", bashResult("same-file-bash-out"));
		});
		expect(session.hasPendingBashMessages).toBe(true);

		expect(await session.switchSession(sessionFile)).toBe(true);
		expect(session.hasPendingBashMessages).toBe(true);
		await flushByNextPrompt(session);

		const stored = await sessionText(session);
		expect(stored).toContain("echo same-file-bash");
		expect(session.hasPendingBashMessages).toBe(false);
	}, 30_000);

	it("keeps an idle bash result in the current session", async () => {
		const { cwd, modelRegistry } = await fixture();
		const manager = SessionManager.create(cwd, cwd);
		manager.appendMessage({ role: "user", content: "S-1", timestamp: 1 });
		await manager.ensureOnDisk();
		const session = await openSession(manager, modelRegistry);
		sessions.push(session);
		let persisted = false;
		session.recordBashResult("echo idle-bash-marker", bashResult("idle-bash-out"), {
			onPersisted: () => {
				persisted = true;
			},
		});
		expect(session.hasPendingBashMessages).toBe(false);
		expect(persisted).toBe(true);
		const live = session.agent.state.messages.map(message => executionText(message)).join("\n");
		const stored = await sessionText(session);
		expect(live).toContain("echo idle-bash-marker");
		expect(stored).toContain("echo idle-bash-marker");
	}, 30_000);

	it("keeps an idle python result in the current session", async () => {
		const { cwd, modelRegistry } = await fixture();
		const manager = SessionManager.create(cwd, cwd);
		manager.appendMessage({ role: "user", content: "S-1", timestamp: 1 });
		await manager.ensureOnDisk();
		const session = await openSession(manager, modelRegistry);
		sessions.push(session);
		let persisted = false;
		session.recordPythonResult("print('idle-python-marker')", pythonResult("idle-python-out"), {
			onPersisted: () => {
				persisted = true;
			},
		});
		expect(session.hasPendingPythonMessages).toBe(false);
		expect(persisted).toBe(true);
		const live = session.agent.state.messages.map(message => executionText(message)).join("\n");
		const stored = await sessionText(session);
		expect(live).toContain("print('idle-python-marker')");
		expect(stored).toContain("print('idle-python-marker')");
	}, 30_000);
});
