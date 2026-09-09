import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentEvent } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import * as sidecar from "@gajae-code/coding-agent/gjc-runtime/session-state-sidecar";
import {
	GJC_COORDINATOR_SESSION_ID_ENV,
	GJC_COORDINATOR_SESSION_STATE_FILE_ENV,
} from "@gajae-code/coding-agent/gjc-runtime/session-state-sidecar";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { createSdkRunCapability } from "@gajae-code/coding-agent/session/sdk-run-capability-internal";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { logger, TempDir } from "@gajae-code/utils";
import { recordCommittedPromptFailure } from "../src/session/committed-prompt-failure";

const originalStateFile = process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV];
const originalSessionId = process.env[GJC_COORDINATOR_SESSION_ID_ENV];
let session: AgentSession | undefined;
let authStorage: AuthStorage | undefined;
let tempDir: TempDir | undefined;

afterEach(async () => {
	// Keep persistence spies installed until every admitted write has settled.
	await session?.dispose();
	vi.restoreAllMocks();
	session = undefined;
	authStorage?.close();
	authStorage = undefined;
	tempDir?.removeSync();
	tempDir = undefined;
	if (originalStateFile === undefined) delete process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV];
	else process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = originalStateFile;
	if (originalSessionId === undefined) delete process.env[GJC_COORDINATOR_SESSION_ID_ENV];
	else process.env[GJC_COORDINATOR_SESSION_ID_ENV] = originalSessionId;
});

async function runResponse(content: string, sdk?: { token: string; onStart(handle: string): void }) {
	tempDir = TempDir.createSync("@gjc-terminal-receipt-");
	const stateFile = path.join(tempDir.path(), "runtime-state.json");
	process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = stateFile;
	process.env[GJC_COORDINATOR_SESSION_ID_ENV] = "terminal-receipt-session";
	authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const modelRegistry = new ModelRegistry(authStorage);
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled model");
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		streamFn: createMockModel({ responses: [{ content: [content] }] }).stream,
	});
	session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry,
	});
	const terminal = Promise.withResolvers<void>();
	session.subscribe(event => {
		if (event.type === "agent_start" && session?.activePromptHandle) sdk?.onStart(session.activePromptHandle);
		if (event.type === "agent_end") terminal.resolve();
	});
	await session.prompt("respond", sdk ? { sdkRunCapability: createSdkRunCapability(sdk.token) } : undefined);
	await terminal.promise;
	await session.awaitSessionSettlement();
	await session.awaitCoordinatorRuntimeStatePersistenceForTests();
	const payload = (await Bun.file(stateFile).json()) as Record<string, unknown>;
	expect(payload.state === "completed" || payload.state === "errored").toBe(true);
	return payload;
}

describe("AgentSession terminal receipt state", () => {
	it("publishes agent_end when terminal sidecar persistence fails", async () => {
		tempDir = TempDir.createSync("@gjc-terminal-persistence-failure-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled model");
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: createMockModel({ responses: [{ content: ["done"] }] }).stream,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});
		const terminal = Promise.withResolvers<void>();
		const persist = vi
			.spyOn(sidecar, "persistCoordinatorRuntimeStateFromEvent")
			.mockRejectedValue(new Error("simulated persistence failure"));
		const persistWarnings: Array<Record<string, unknown> | undefined> = [];
		vi.spyOn(logger, "warn").mockImplementation((message, context) => {
			if (message === "Failed to persist coordinator runtime state") persistWarnings.push(context);
		});

		session.subscribe(event => {
			if (event.type === "agent_end") terminal.resolve();
		});

		await session.prompt("respond");
		await terminal.promise;
		expect(persist).toHaveBeenCalled();
		expect(persistWarnings).toHaveLength(1);
		expect(persistWarnings[0]).toMatchObject({ error: "Error: simulated persistence failure" });
	});

	it("publishes agent_end while terminal sidecar persistence remains pending", async () => {
		tempDir = TempDir.createSync("@gjc-terminal-persistence-pending-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled model");
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: createMockModel({ responses: [{ content: ["done"] }] }).stream,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});
		const pending = Promise.withResolvers<"completed" | "skipped">();
		vi.spyOn(sidecar, "persistCoordinatorRuntimeStateFromEvent").mockReturnValue(pending.promise);
		const terminal = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "agent_end") terminal.resolve();
		});

		try {
			await session.prompt("respond");
			await Promise.race([terminal.promise, Bun.sleep(250).then(() => "timed_out" as const)]).then(result => {
				expect(result).not.toBe("timed_out");
			});
		} finally {
			pending.resolve("completed");
		}
	});

	it("writes present receipt truth through the real AgentSession event consumer", async () => {
		expect(await runResponse("done")).toMatchObject({
			state: "completed",
			execution_state: "terminal_ok",
			receipt_state: "present",
			final_response: { text: "done" },
		});
	});

	it("writes receipt_missing through the real AgentSession event consumer", async () => {
		expect(await runResponse("   ")).toMatchObject({
			state: "completed",
			execution_state: "terminal_ok",
			receipt_state: "missing",
			error: { code: "receipt_missing" },
		});
	});

	it("preserves same-run failure across attempt scopes and resets it for a successful successor", async () => {
		tempDir = TempDir.createSync("@gjc-run-failure-receipt-");
		const stateFile = path.join(tempDir.path(), "runtime-state.json");
		process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = stateFile;
		process.env[GJC_COORDINATOR_SESSION_ID_ENV] = "run-failure-receipt";
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled model");
		const gate = Promise.withResolvers<void>();
		const successorGate = Promise.withResolvers<void>();
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: createMockModel({
				responses: [
					async () => {
						await gate.promise;
						return { content: ["   "] };
					},
					{ content: ["   "] },
					async () => {
						await successorGate.promise;
						return { content: ["successor done"] };
					},
				],
			}).stream,
		});
		const subscribe = vi.spyOn(agent, "subscribe");
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage),
		});
		const consumer = subscribe.mock.calls[0]?.[0];
		if (!consumer) throw new Error("Expected AgentSession event consumer");
		const started = Promise.withResolvers<Extract<AgentEvent, { type: "agent_start" }>>();
		session.subscribe(event => {
			if (event.type === "agent_start") started.resolve(event);
		});
		const persist = vi.spyOn(sidecar, "persistCoordinatorRuntimeStateFromEvent");
		const first = session.prompt("empty failed run", { sdkRunCapability: createSdkRunCapability("failed-run") });
		const start = await started.promise;
		if (!start.scope) throw new Error("Expected attempt scope");
		const firstExecutionHandle = session.activePromptHandle;
		if (!firstExecutionHandle) throw new Error("Expected active execution handle");
		// The diagnostic uses the accepted scope. A second accepted invocation with
		// the same SDK capability below exercises cross-attempt logical ownership.
		await consumer({
			type: "agent_failed",
			scope: start.scope,
			error: { code: "provider_error", message: "private failure" },
		});
		gate.resolve();
		await first;
		await session.waitForIdle();
		async function waitForState(
			predicate: (state: Record<string, unknown>) => boolean,
		): Promise<Record<string, unknown>> {
			if (!session) throw new Error("Expected session");
			await session.awaitSessionSettlement();
			// agent_end and transcript settlement do not join the secondary sidecar
			// sink. Fence its actual queued writes before inspecting durable truth.
			await session.awaitCoordinatorRuntimeStatePersistenceForTests();
			const state = (await Bun.file(stateFile).json()) as Record<string, unknown>;
			if (predicate(state)) return state;
			const lifecycle = persist.mock.calls.map(([event]) => ({
				type: event.type,
				sdkRunToken: event.sdkRunToken,
				scope: event.scope,
			}));
			throw new Error(
				`Unexpected run-correlated terminal state: ${JSON.stringify(state)}; lifecycle=${JSON.stringify(lifecycle)}`,
			);
		}
		const failed = await waitForState(state => state.execution_state === "failed");
		expect(failed).toMatchObject({ state: "errored", execution_state: "failed", receipt_state: "absent" });
		const repeatedStart = Promise.withResolvers<Extract<AgentEvent, { type: "agent_start" }>>();
		const unsubscribeRepeated = session.subscribe(event => {
			if (event.type === "agent_start") repeatedStart.resolve(event);
		});
		await session.prompt("same logical run next attempt", { sdkRunCapability: createSdkRunCapability("failed-run") });
		const nextStart = await repeatedStart.promise;
		unsubscribeRepeated();
		expect(nextStart.scope).not.toBe(start.scope);
		await session.waitForIdle();
		await waitForState(state => state.execution_state === "failed" && state.updated_at !== failed.updated_at);
		for (const type of ["agent_start", "turn_start", "agent_failed", "agent_end"]) {
			expect(persist.mock.calls.some(([event]) => event.type === type && event.sdkRunToken === "failed-run")).toBe(
				true,
			);
		}
		const successorStart = Promise.withResolvers<void>();
		const unsubscribeSuccessor = session.subscribe(event => {
			if (event.type === "agent_start") successorStart.resolve();
		});
		const successorPrompt = session.prompt("successful successor", {
			sdkRunCapability: createSdkRunCapability("successor-run"),
		});
		await successorStart.promise;
		unsubscribeSuccessor();
		// A late predecessor diagnostic must never borrow the successor's token.
		await consumer({
			type: "agent_failed",
			scope: start.scope,
			error: { code: "provider_error", message: "late predecessor" },
		});
		successorGate.resolve();
		await successorPrompt;
		await session.waitForIdle();
		const successor = await waitForState(state => state.execution_state === "terminal_ok");
		expect(successor).toMatchObject({ receipt_state: "present", final_response: { text: "successor done" } });
		expect(successor.run_failure).toBeUndefined();
		expect(successor.error).toBeUndefined();
		expect(successor.run_provenance).not.toBe(failed.run_provenance);
		expect(
			await recordCommittedPromptFailure(
				session,
				firstExecutionHandle,
				{ code: "prompt_deadline_exceeded", message: "Prompt deadline exceeded." },
				() => true,
			),
		).toBe("stale");
	});

	it("projects a committed deadline after empty terminal using the original execution handle", async () => {
		let executionHandle: string | undefined;
		const empty = await runResponse("   ", {
			token: "committed-deadline",
			onStart: handle => {
				executionHandle = handle;
			},
		});
		expect(empty.receipt_state).toBe("missing");
		if (!session || !executionHandle || !tempDir) throw new Error("Expected accepted SDK execution");
		const failure = { code: "prompt_deadline_exceeded", message: "Prompt deadline exceeded." } as const;
		expect(await recordCommittedPromptFailure(session, executionHandle, failure, () => true)).toBe("persisted");
		const state = await Bun.file(path.join(tempDir.path(), "runtime-state.json")).json();
		expect(state).toMatchObject({ state: "errored", execution_state: "failed", receipt_state: "absent" });
		expect(state.run_provenance).toBe(empty.run_provenance);
		expect(await recordCommittedPromptFailure(session, executionHandle, failure, () => false)).toBe("stale");
		expect(await recordCommittedPromptFailure(session, "unknown-successor-handle", failure, () => true)).toBe(
			"stale",
		);
	});

	for (const surface of ["prompt", "sendUserMessage", "promptCustomMessage"] as const) {
		it(`${surface} rejects raw forged SDK provenance and accepts only the branded capability`, async () => {
			const persist = vi.spyOn(sidecar, "persistCoordinatorRuntimeStateFromEvent");
			await runResponse("seed");
			if (!session) throw new Error("Expected session");
			await session.waitForIdle();
			await session.awaitSessionSettlement();
			session.agent.streamFn = createMockModel({
				responses: [{ content: ["ordinary"] }, { content: ["authorized"] }],
			}).stream;
			persist.mockClear();
			const submit = async (authorized: boolean) => {
				const options = {
					sdkRunToken: "forged-token",
					...(authorized
						? { sdkRunCapability: createSdkRunCapability("authorized-token") }
						: { sdkRunCapability: { sdkRunToken: "forged-token" } }),
				};
				if (surface === "prompt") await session!.prompt("input", options);
				else if (surface === "sendUserMessage") await session!.sendUserMessage("input", options);
				else
					await session!.promptCustomMessage(
						{ customType: "test-input", content: "input", display: true },
						options,
					);
				await session!.waitForIdle();
				await session!.awaitSessionSettlement();
				if (!tempDir) throw new Error("Expected sidecar fixture");
				const expectedText = authorized ? "authorized" : "ordinary";
				await session!.awaitCoordinatorRuntimeStatePersistenceForTests();
				const state = (await Bun.file(path.join(tempDir.path(), "runtime-state.json")).json()) as {
					final_response?: { text?: string };
				};
				expect(state.final_response?.text).toBe(expectedText);
			};
			await submit(false);
			expect(persist.mock.calls.map(([event]) => event.type)).toContain("agent_start");
			expect(persist.mock.calls.every(([event]) => event.sdkRunToken === undefined)).toBe(true);
			persist.mockClear();
			await submit(true);
			for (const type of ["agent_start", "turn_start", "agent_end"]) {
				expect(
					persist.mock.calls.some(([event]) => event.type === type && event.sdkRunToken === "authorized-token"),
				).toBe(true);
			}
			expect(persist.mock.calls.some(([event]) => event.sdkRunToken === "forged-token")).toBe(false);
		});
	}
});
