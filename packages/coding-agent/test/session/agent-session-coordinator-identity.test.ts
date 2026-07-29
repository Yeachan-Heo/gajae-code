import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai/models";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import {
	GJC_COORDINATOR_SESSION_ID_ENV,
	GJC_COORDINATOR_SESSION_STATE_FILE_ENV,
} from "@gajae-code/coding-agent/gjc-runtime/session-state-sidecar";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { logger, postmortem, TempDir } from "@gajae-code/utils";

const originalStateFile = process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV];
const originalSessionId = process.env[GJC_COORDINATOR_SESSION_ID_ENV];
const sessions: AgentSession[] = [];
const tempDirs: TempDir[] = [];
const authStores: AuthStorage[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(sessions.splice(0).map(session => session.dispose()));
	for (const authStore of authStores.splice(0)) authStore.close();
	for (const tempDir of tempDirs.splice(0)) tempDir.removeSync();
	if (originalStateFile === undefined) delete process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV];
	else process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = originalStateFile;
	if (originalSessionId === undefined) delete process.env[GJC_COORDINATOR_SESSION_ID_ENV];
	else process.env[GJC_COORDINATOR_SESSION_ID_ENV] = originalSessionId;
});

async function createSession(
	extensionRunner?: unknown,
	tempDir = TempDir.createSync("@pi-coordinator-identity-"),
): Promise<{
	session: AgentSession;
	tempDir: TempDir;
}> {
	if (!tempDirs.includes(tempDir)) tempDirs.push(tempDir);
	const authStore = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
	authStores.push(authStore);
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled model");
	const manager = SessionManager.create(tempDir.path(), tempDir.path());
	manager.ensureOnDisk();
	manager.appendCustomEntry("test-session", { created: true });
	const session = new AgentSession({
		agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
		sessionManager: manager,
		settings: Settings.isolated(),
		modelRegistry: new ModelRegistry(authStore),
		extensionRunner: extensionRunner as never,
	});
	sessions.push(session);
	return { session, tempDir };
}

async function waitFor(check: () => boolean, description: string): Promise<void> {
	for (let index = 0; index < 100; index++) {
		if (check()) return;
		await Bun.sleep(1);
	}
	throw new Error(`Timed out waiting for ${description}`);
}

async function emitTurnStartAndRead(session: AgentSession, stateFile: string): Promise<Record<string, unknown>> {
	session.agent.emitExternalEvent({ type: "turn_start" });
	await session.waitForIdle();
	await waitFor(() => Bun.file(stateFile).size > 0, "initial runtime-state marker");
	return JSON.parse(await Bun.file(stateFile).text()) as Record<string, unknown>;
}

async function waitForSessionFile(stateFile: string, sessionFile: string): Promise<Record<string, unknown>> {
	for (let index = 0; index < 100; index++) {
		try {
			const payload = JSON.parse(await Bun.file(stateFile).text()) as Record<string, unknown>;
			if (payload.session_file === sessionFile) return payload;
		} catch {}
		await Bun.sleep(1);
	}
	throw new Error(`Timed out waiting for rotated runtime-state marker ${sessionFile}`);
}

describe("AgentSession coordinator runtime-state identity rotation", () => {
	it("rotates /new and switch identities only after commit, replaces its finalizer, and rolls back without marker drift", async () => {
		const extensionEvents: Array<{ type: string; sequence: number }> = [];
		let sequence = 0;
		let throwSessionSwitch = false;
		const extensionRunner = {
			hasHandlers: () => false,
			emit: async (event: { type: string }) => {
				extensionEvents.push({ type: event.type, sequence: ++sequence });
				if (event.type === "session_switch" && throwSessionSwitch) throw new Error("switch hook failed");
			},
		};
		const tempDir = TempDir.createSync("@pi-coordinator-identity-");
		tempDirs.push(tempDir);
		const stateFile = path.join(tempDir.path(), "coordinator-state.json");
		process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = stateFile;
		process.env[GJC_COORDINATOR_SESSION_ID_ENV] = "fixed-tmux-coordinator";
		const registrations = new Map<number, (reason: postmortem.Reason) => void | Promise<void>>();
		let registrationId = 0;
		const originalRegister = postmortem.register;
		vi.spyOn(postmortem, "register").mockImplementation(((
			id: string,
			callback: (reason: postmortem.Reason) => void | Promise<void>,
		) => {
			const key = ++registrationId;
			if (id === "coordinator-runtime-state") registrations.set(key, callback);
			const unregister = originalRegister(id, callback);
			return () => {
				registrations.delete(key);
				unregister();
			};
		}) as typeof postmortem.register);
		const { session } = await createSession(extensionRunner, tempDir);

		expect(registrations.size).toBe(1);
		const predecessorFile = session.sessionManager.getSessionFile();
		expect(predecessorFile).toBeDefined();
		await emitTurnStartAndRead(session, stateFile);
		const warn = vi.spyOn(logger, "warn");
		expect(await session.newSession()).toBe(true);
		const afterNewFile = session.sessionManager.getSessionFile();
		expect(afterNewFile).toBeDefined();
		expect(afterNewFile).not.toBe(predecessorFile);
		await emitTurnStartAndRead(session, stateFile);
		const afterNew = await waitForSessionFile(stateFile, afterNewFile!);
		expect(afterNew.session_file).toBe(afterNewFile);
		expect(warn.mock.calls.filter(call => call[0] === "Failed to persist coordinator runtime state")).toHaveLength(0);
		expect(registrations.size).toBe(1);

		const markerBeforeSwitch = await Bun.file(stateFile).text();
		const successorManager = SessionManager.create(tempDir.path(), tempDir.path());
		successorManager.ensureOnDisk();
		successorManager.appendCustomEntry("test-successor", { created: true });
		const successorFile = successorManager.getSessionFile();
		if (!successorFile) throw new Error("Expected second transcript");
		const writes: number[] = [];
		const originalWrite = Bun.write;
		const write = vi.spyOn(Bun, "write").mockImplementation((async (target: unknown, ...args: unknown[]) => {
			if (target === stateFile) writes.push(++sequence);
			return (originalWrite as (writeTarget: unknown, ...writeArgs: unknown[]) => Promise<number>)(target, ...args);
		}) as typeof Bun.write);
		try {
			expect(await session.switchSession(successorFile)).toBe(true);
			await waitFor(() => writes.length > 0, "authorized switch rotation");
		} finally {
			write.mockRestore();
		}
		expect((JSON.parse(await Bun.file(stateFile).text()) as Record<string, unknown>).session_file).toBe(
			successorFile,
		);
		const switchEvent = extensionEvents.findLast(event => event.type === "session_switch");
		expect(switchEvent).toBeDefined();
		expect(writes.at(-1)).toBeGreaterThan(switchEvent!.sequence);
		expect(registrations.size).toBe(1);

		const activeFinalizer = [...registrations.values()].at(0);
		expect(activeFinalizer).toBeDefined();
		await activeFinalizer!(postmortem.Reason.MANUAL);
		expect((JSON.parse(await Bun.file(stateFile).text()) as Record<string, unknown>).session_file).toBe(
			successorFile,
		);

		const beforeFailedSwitch = await Bun.file(stateFile).text();
		throwSessionSwitch = true;
		await expect(session.switchSession(afterNewFile!)).rejects.toThrow("switch hook failed");
		expect(session.sessionManager.getSessionFile()).toBe(successorFile);
		expect(await Bun.file(stateFile).text()).toBe(beforeFailedSwitch);
		expect(registrations.size).toBe(1);
		await activeFinalizer!(postmortem.Reason.MANUAL);
		expect((JSON.parse(await Bun.file(stateFile).text()) as Record<string, unknown>).session_file).toBe(
			successorFile,
		);
		expect(markerBeforeSwitch).not.toBe(beforeFailedSwitch);
	});
});
