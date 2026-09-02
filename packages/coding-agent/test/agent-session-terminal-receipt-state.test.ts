import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import {
	resetPersistFailureWarnWindows,
	SessionStateLockUnavailableError,
} from "@gajae-code/coding-agent/gjc-runtime/session-state-lock";
import * as sidecar from "@gajae-code/coding-agent/gjc-runtime/session-state-sidecar";
import {
	GJC_COORDINATOR_SESSION_ID_ENV,
	GJC_COORDINATOR_SESSION_STATE_FILE_ENV,
} from "@gajae-code/coding-agent/gjc-runtime/session-state-sidecar";
import { createSdkRunCapability } from "@gajae-code/coding-agent/sdk/host/sdk-run-capability";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { logger, TempDir } from "@gajae-code/utils";

const originalStateFile = process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV];
const originalSessionId = process.env[GJC_COORDINATOR_SESSION_ID_ENV];
let session: AgentSession | undefined;
let authStorage: AuthStorage | undefined;
let tempDir: TempDir | undefined;

afterEach(async () => {
	vi.restoreAllMocks();
	await session?.dispose();
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

async function runResponse(content: string) {
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
		if (event.type === "agent_end") terminal.resolve();
	});
	await session.prompt("respond");
	await terminal.promise;
	for (let attempt = 0; attempt < 100; attempt++) {
		if (await Bun.file(stateFile).exists()) {
			const payload = JSON.parse(await Bun.file(stateFile).text()) as Record<string, unknown>;
			if (payload.state === "completed" || payload.state === "errored") return payload;
		}
		await Bun.sleep(10);
	}
	throw new Error("Timed out waiting for terminal runtime state");
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
		resetPersistFailureWarnWindows();
		const lockFailure = new Error("marker unreadable", {
			cause: new SessionStateLockUnavailableError({
				lockPath: "/tmp/runtime-state.json.lock.transition",
				reason: "transition_claim_timeout",
			}),
		});
		const persist = vi.spyOn(sidecar, "persistCoordinatorRuntimeStateFromEvent").mockRejectedValue(lockFailure);
		const warned: Array<Record<string, unknown> | undefined> = [];
		const debugged: Array<Record<string, unknown> | undefined> = [];
		vi.spyOn(logger, "warn").mockImplementation((message, context) => {
			if (message.startsWith("Failed to persist")) warned.push(context);
		});
		vi.spyOn(logger, "debug").mockImplementation((message, context) => {
			if (message.startsWith("Failed to persist")) debugged.push(context);
		});
		session.subscribe(event => {
			if (event.type === "agent_end") terminal.resolve();
		});

		await session.prompt("respond");
		await terminal.promise;
		expect(persist).toHaveBeenCalled();
		expect(persist.mock.calls.length).toBeGreaterThan(1);
		// The first failure warns with the actionable lock detail; the rest of the
		// same session's failures inside the 30s window drop to debug.
		expect(warned).toHaveLength(1);
		expect(warned[0]).toMatchObject({
			error: String(lockFailure),
			reason: "transition_claim_timeout",
			lockPath: "/tmp/runtime-state.json.lock.transition",
		});
		expect(debugged.length).toBeGreaterThanOrEqual(1);
		for (const entry of debugged) {
			expect(entry).toMatchObject({ reason: "transition_claim_timeout", suppressed: true });
		}
	});

	it("reports an SDK-published terminal persistence failure exactly once, with lock fields", async () => {
		tempDir = TempDir.createSync("@gjc-terminal-persistence-sdk-");
		const stateFile = path.join(tempDir.path(), "runtime-state.json");
		process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = stateFile;
		process.env[GJC_COORDINATOR_SESSION_ID_ENV] = "terminal-receipt-sdk-session";
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
		resetPersistFailureWarnWindows();
		const lockFailure = new Error("marker unreadable", {
			cause: new SessionStateLockUnavailableError({
				lockPath: "/tmp/runtime-state.json.lock.transition",
				reason: "transition_claim_timeout",
			}),
		});
		vi.spyOn(sidecar, "persistCoordinatorRuntimeStateFromEvent").mockRejectedValue(lockFailure);
		const warned: Array<{ message: string; context: Record<string, unknown> | undefined }> = [];
		vi.spyOn(logger, "warn").mockImplementation((message, context) => {
			if (/persist/iu.test(message)) warned.push({ message, context });
		});
		vi.spyOn(logger, "debug").mockImplementation(() => undefined);
		const terminal = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "agent_end") terminal.resolve();
		});

		await session.sendUserMessage("respond", {
			sdkRunCapability: createSdkRunCapability("terminal-receipt-sdk-token"),
		});
		await terminal.promise;
		// Dispose drains every queued coordinator persist, so no late warn can land after
		// the assertion.
		await session.dispose();
		session = undefined;

		// One warn for the whole session in the window, carrying the lock diagnostics;
		// no second, unsuppressed warn from the SDK publication path.
		expect(warned).toHaveLength(1);
		expect(warned[0]?.context).toMatchObject({
			reason: "transition_claim_timeout",
			lockPath: "/tmp/runtime-state.json.lock.transition",
		});
	});

	it("names the runtime-state document in every persist-failure log", async () => {
		// The suppression window is keyed by this document (see #warnPersistFailure), so
		// the field is both the operator's identity for the failure and the proof that
		// the caller keys on the resolved document rather than on the session id.
		// `shouldWarnPersistFailure` key independence itself is covered in
		// session-state-lock.test.ts.
		resetPersistFailureWarnWindows();
		tempDir = TempDir.createSync("@gjc-terminal-persistence-document-");
		const document = path.join(tempDir.path(), "doc-a.json");
		process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = document;
		process.env[GJC_COORDINATOR_SESSION_ID_ENV] = "document-session";
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
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
			modelRegistry: new ModelRegistry(authStorage),
		});
		vi.spyOn(sidecar, "persistCoordinatorRuntimeStateFromEvent").mockRejectedValue(
			new Error("marker unreadable", {
				cause: new SessionStateLockUnavailableError({
					lockPath: `${document}.lock.transition`,
					reason: "transition_claim_timeout",
				}),
			}),
		);
		const warned: Array<Record<string, unknown> | undefined> = [];
		const debugged: Array<Record<string, unknown> | undefined> = [];
		vi.spyOn(logger, "warn").mockImplementation((message, context) => {
			if (/persist/iu.test(message)) warned.push(context);
		});
		vi.spyOn(logger, "debug").mockImplementation((message, context) => {
			if (/persist/iu.test(message)) debugged.push(context);
		});
		const terminal = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "agent_end") terminal.resolve();
		});

		await session.prompt("respond");
		await terminal.promise;
		await session.dispose();
		session = undefined;

		// One warn for the document, every in-window repeat demoted, and BOTH levels
		// name the document they failed on.
		expect(warned).toHaveLength(1);
		expect(warned[0]).toMatchObject({ stateFile: document, reason: "transition_claim_timeout" });
		expect(debugged.length).toBeGreaterThanOrEqual(1);
		for (const entry of debugged) expect(entry).toMatchObject({ stateFile: document, suppressed: true });
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
		const pending = Promise.withResolvers<void>();
		vi.spyOn(sidecar, "persistCoordinatorRuntimeStateFromEvent").mockReturnValue(pending.promise);
		const terminal = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "agent_end") terminal.resolve();
		});

		await session.prompt("respond");
		await Promise.race([terminal.promise, Bun.sleep(250).then(() => "timed_out" as const)]).then(result => {
			expect(result).not.toBe("timed_out");
		});
		pending.resolve();
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
});
